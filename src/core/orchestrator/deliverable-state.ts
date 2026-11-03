/**
 * MYPES Platform — Pure per-deliverable state function (KAN-28 / KAN-64)
 * =======================================================================
 *
 * The second pure, table-testable artifact of the thesis claim (next to the
 * planner): same snapshot + same workflow facts ⇒ same states, same allowed
 * commands, same state tokens. No I/O, no LLM, no clock, no randomness, and
 * no agent- or field-specific branching: dependencies come from the
 * declarative map in the Agent Cards (`mypes:deliverable.dependsOn`).
 *
 * KAN-64 transition table (identifiers in English, see contracts/deliverables.ts):
 *
 *   blocked    required brief fields not filled, or an upstream kind is not
 *              approved (a flagged approval still counts, KAN-35) → no commands
 *   enabled    preconditions met, no active task, no candidate yet
 *                                                            → generate
 *   generating latest task pending / in_progress             → cancel (pending only)
 *   in_review  ≥1 candidate, none approved                   → iterate, approve
 *   approved   one approved candidate                        → iterate, approve(other)
 *   failed     latest task failed                            → FAILURE_RECOVERY_COMMANDS
 *              by category (KAN-58: never a dead end): retry for every
 *              category, plus iterate for content_policy
 *   stale      «Potencialmente desactualizado» overlay on approved / in_review
 *              (RF-07, KAN-35): the current candidate (the approved one, else
 *              the newest) was generated from inputs that changed since — a
 *              brief field it recorded as used, or an upstream approval it
 *              was created under (see `deriveStaleCandidateIds`)
 *                                                           → iterate, generate,
 *                                                              approve(other); never automatic
 *
 * Precedence (first match wins): generating, failed, approved, in_review,
 * enabled, blocked. Canceled tasks are ignored, so Cancelar returns the
 * deliverable to the state it had before the canceled task.
 *
 * Generative commands (generate, iterate, retry) additionally require the
 * preconditions to hold *now*: a deliverable with candidates whose brief
 * lost a required field stays `in_review`/`approved`, but Iterar is not
 * offered until the field is filled again (P0285: every command re-validates
 * preconditions). Aprobar spends nothing and stays available.
 */

import {
  DELIVERABLE_COMMAND_ORDER,
  type ConversationSnapshot,
  type DeliverableCandidateView,
  type DeliverableCommandKind,
  type DeliverableId,
  type DeliverableStateKind,
  type DeliverableStateView,
  type FieldSlot,
} from '../contracts';
import { changedFields } from '../deliverable-inputs';
import type { TaskErrorCategory } from '../task-errors';
import type { DeliverableSpec } from './agent-registry';
import type { WorkflowCandidate, WorkflowTask } from './deliverable-workflow';

/**
 * Recovery commands a failed deliverable offers, per failure category
 * (KAN-58: a failed deliverable is never a dead end). Like every generative
 * command they also need the preconditions to hold now.
 *
 *   transient      Reintentar — the same request is expected to succeed later.
 *   content_policy Reintentar + Iterar — retrying the identical request will
 *                  likely be blocked again, so Iterar lets the user change it
 *                  (an iteration of the failed task carrying an observation).
 *   permanent_bug  Reintentar — changing the request does not fix a
 *                  configuration or provider bug, but a retry succeeds once
 *                  the operator fixes it.
 *
 * A failed task without a category (legacy rows) is treated as permanent_bug.
 * Retry caps are deferred to KAN-43.
 */
export const FAILURE_RECOVERY_COMMANDS: Readonly<Record<TaskErrorCategory, ReadonlyArray<DeliverableCommandKind>>> = {
  transient: ['retry'],
  content_policy: ['retry', 'iterate'],
  permanent_bug: ['retry'],
};

/** Approval facts for one kind, as read from the approval store. */
export interface ApprovalFact {
  readonly deliverableKind: string;
  readonly deliverableId: string;
}

/** Everything the state function reads besides the snapshot. */
export interface DeliverableWorkflowFacts {
  /** All tasks of the conversation (any agent). */
  readonly tasks: ReadonlyArray<WorkflowTask>;
  /** All candidates (deliverables) of the conversation (any kind). */
  readonly candidates: ReadonlyArray<WorkflowCandidate>;
  /** Current approval per kind. */
  readonly approvals: ReadonlyArray<ApprovalFact>;
  /**
   * Kinds the approval store explicitly marked stale (newest mark newer than
   * the kind's newest approval). Staleness source only for tasks created
   * before KAN-35; newer ones are compared with their recorded inputs.
   */
  readonly markedStaleKinds: ReadonlyArray<string>;
}

export const EMPTY_WORKFLOW_FACTS: DeliverableWorkflowFacts = Object.freeze({
  tasks: [],
  candidates: [],
  approvals: [],
  markedStaleKinds: [],
});

/**
 * Legacy staleness rule (KAN-34), used only for deliverables whose task
 * predates the KAN-35 upstream record: an approved kind is stale exactly when
 * the approval store holds an explicit stale mark for it. Marks are written
 * atomically with every new or replaced approval for all (transitive)
 * dependents, and a later approval of the kind clears its own mark. Approval
 * timestamps are never compared (owner decision 2026-10-25): two racing
 * approvals cannot produce a false «obsoleto». Marks on kinds with nothing
 * approved are ignored.
 */
export function deriveStaleKinds(
  approvals: ReadonlyArray<ApprovalFact>,
  markedStaleKinds: ReadonlyArray<string>,
): ReadonlySet<string> {
  const approved = new Set(approvals.map((a) => a.deliverableKind));
  return new Set(markedStaleKinds.filter((kind) => approved.has(kind)));
}

/**
 * Every kind that depends on `kind`, directly or transitively, sorted. The
 * command handler passes them to `IApprovalStore.approve` so the store marks
 * them stale in the same atomic write as the approval.
 */
export function dependentKindsOf(
  kind: string,
  specs: ReadonlyArray<DeliverableSpec>,
): ReadonlyArray<string> {
  const out = new Set<string>();
  const queue = [kind];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const spec of specs) {
      if (spec.dependsOn.includes(current) && !out.has(spec.deliverableKind) && spec.deliverableKind !== kind) {
        out.add(spec.deliverableKind);
        queue.push(spec.deliverableKind);
      }
    }
  }
  return [...out].sort();
}

/** Requirements payload: every filled required/optional slot of the agent. */
export function requirementsFromSnapshot(
  snapshot: ConversationSnapshot,
  agentId: string,
): Record<string, unknown> {
  const agentState = snapshot.agentStates[agentId];
  const requirements: Record<string, unknown> = {};
  if (!agentState) return requirements;
  for (const [fieldName, slot] of Object.entries(agentState.requiredFields) as Array<[string, FieldSlot]>) {
    if (slot.status === 'filled') requirements[fieldName] = slot.value;
  }
  for (const [fieldName, slot] of Object.entries(agentState.optionalFields) as Array<[string, FieldSlot]>) {
    if (slot.status === 'filled') requirements[fieldName] = slot.value;
  }
  return requirements;
}

/**
 * Candidates (and approved deliverables) that are potentially outdated
 * (RF-07, KAN-35). Pure: computed from append-only facts, never stored.
 *
 * A candidate is stale when
 *   - a brief field its handler recorded as used (`inputVersions`) now has
 *     another version, or is no longer filled; or
 *   - its task recorded the upstream approvals it was created under and, for
 *     any `dependsOn` kind, the current approval differs (replaced, or none).
 * One hop per real change: a stale upstream does not flag its dependents
 * until the upstream is actually replaced (then the recorded id differs).
 * Candidates whose task predates KAN-35 (no upstream record) fall back to the
 * KAN-34 rule: an approved deliverable whose kind holds an explicit stale mark.
 */
export function deriveStaleCandidateIds(
  snapshot: ConversationSnapshot,
  specs: ReadonlyArray<DeliverableSpec>,
  facts: DeliverableWorkflowFacts,
): ReadonlySet<string> {
  const marked = deriveStaleKinds(facts.approvals, facts.markedStaleKinds);
  const approvalOf = (kind: string) => facts.approvals.find((a) => a.deliverableKind === kind)?.deliverableId ?? null;

  const isStale = (kind: string, deliverableId: string): boolean => {
    const spec = specs.find((s) => s.deliverableKind === kind);
    const candidate = facts.candidates.find((c) => c.deliverableId === deliverableId);
    if (spec && candidate?.inputVersions) {
      if (changedFields(candidate.inputVersions, requirementsFromSnapshot(snapshot, spec.agentId)).length > 0) return true;
    }
    const upstream = candidate ? facts.tasks.find((t) => t.id === candidate.agentTaskId)?.upstreamApprovals : null;
    if (!spec || !upstream) return approvalOf(kind) === deliverableId && marked.has(kind);
    return spec.dependsOn.some((upKind) => (upstream[upKind] ?? null) !== approvalOf(upKind));
  };

  const out = new Set<string>();
  for (const { kind, deliverableId } of [
    ...facts.candidates.map((c) => ({ kind: c.kind, deliverableId: c.deliverableId as string })),
    ...facts.approvals.map((a) => ({ kind: a.deliverableKind, deliverableId: a.deliverableId })),
  ]) {
    if (isStale(kind, deliverableId)) out.add(deliverableId);
  }
  return out;
}

export interface DeriveDeliverableStateInput {
  readonly spec: DeliverableSpec;
  readonly facts: DeliverableWorkflowFacts;
  /** Kinds with a current approval, flagged or not (upstream gate). */
  readonly usableApprovedKinds: ReadonlySet<string>;
  /** Potentially outdated candidates, from `deriveStaleCandidateIds`. */
  readonly staleCandidateIds: ReadonlySet<string>;
}

/** Derive the state of one deliverable. Pure. */
export function deriveDeliverableState(
  snapshot: ConversationSnapshot,
  input: DeriveDeliverableStateInput,
): DeliverableStateView {
  const { spec, facts } = input;
  const agentState = snapshot.agentStates[spec.agentId];

  const missingFields = spec.requiredFields
    .filter((field) => agentState?.requiredFields[field]?.status !== 'filled')
    .sort();
  const missingUpstream = spec.dependsOn
    .filter((kind) => !input.usableApprovedKinds.has(kind))
    .sort();
  const preconditionsMet = missingFields.length === 0 && missingUpstream.length === 0;

  const ownTasks = facts.tasks
    .filter((task) => task.agentId === spec.agentId && task.status !== 'canceled')
    .slice()
    .sort(byCreation);
  const latest = ownTasks.length > 0 ? ownTasks[ownTasks.length - 1] : null;

  const candidates: DeliverableCandidateView[] = facts.candidates
    .filter((candidate) => candidate.kind === spec.deliverableKind)
    .slice()
    .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.deliverableId, b.deliverableId))
    .map((candidate) => ({
      deliverableId: candidate.deliverableId,
      taskId: candidate.agentTaskId,
      contentUrl: candidate.contentUrl,
      contentInline: candidate.contentInline,
      createdAt: candidate.createdAt,
    }));

  const approval = facts.approvals.find((a) => a.deliverableKind === spec.deliverableKind) ?? null;
  const approvedDeliverableId = (approval?.deliverableId ?? null) as DeliverableId | null;
  const hasOtherCandidate = candidates.some((c) => c.deliverableId !== approvedDeliverableId);
  // The result the overlay talks about: the approved candidate, else the newest one.
  const currentId = approvedDeliverableId ?? candidates.at(-1)?.deliverableId ?? null;
  const currentStale = currentId !== null && input.staleCandidateIds.has(currentId);

  let state: DeliverableStateKind;
  const allowed = new Set<DeliverableCommandKind>();

  if (latest && (latest.status === 'pending' || latest.status === 'in_progress')) {
    state = 'generating';
    if (latest.status === 'pending') allowed.add('cancel');
  } else if (latest && latest.status === 'failed') {
    state = 'failed';
    if (preconditionsMet) {
      for (const command of FAILURE_RECOVERY_COMMANDS[latest.errorCategory ?? 'permanent_bug']) allowed.add(command);
    }
  } else if (approvedDeliverableId !== null) {
    state = 'approved';
    if (hasOtherCandidate) allowed.add('approve');
    if (preconditionsMet) allowed.add('iterate');
    if (preconditionsMet && currentStale) allowed.add('generate');
  } else if (candidates.length > 0) {
    state = 'in_review';
    allowed.add('approve');
    if (preconditionsMet) allowed.add('iterate');
    if (preconditionsMet && currentStale) allowed.add('generate');
  } else if (preconditionsMet) {
    state = 'enabled';
    allowed.add('generate');
  } else {
    state = 'blocked';
  }

  const stale = (state === 'approved' || state === 'in_review') && currentStale;
  const allowedCommands = DELIVERABLE_COMMAND_ORDER.filter((kind) => allowed.has(kind));
  const activeTask =
    latest && (latest.status === 'pending' || latest.status === 'in_progress')
      ? { taskId: latest.id, status: latest.status }
      : null;
  const lastFailure =
    latest && latest.status === 'failed'
      ? {
          taskId: latest.id,
          errorCategory: latest.errorCategory,
          errorKind: latest.errorKind ?? null,
          retryable: latest.errorCategory === 'transient',
        }
      : null;

  const stateToken = tokenOf([
    'v1',
    spec.agentId,
    state,
    stale ? 'stale' : 'fresh',
    allowedCommands.join(','),
    latest ? `${latest.id}:${latest.status}` : '-',
    approvedDeliverableId ?? '-',
    candidates.map((c) => c.deliverableId).join(','),
    missingFields.join(','),
    missingUpstream.join(','),
  ]);

  return {
    agentId: spec.agentId,
    deliverableKind: spec.deliverableKind,
    state,
    stale,
    allowedCommands,
    missingFields,
    missingUpstream,
    activeTask,
    lastFailure,
    candidates,
    approvedDeliverableId,
    stateToken,
  };
}

/** Derive every registered deliverable's state, sorted by agentId. Pure. */
export function deriveDeliverableStates(
  snapshot: ConversationSnapshot,
  specs: ReadonlyArray<DeliverableSpec>,
  facts: DeliverableWorkflowFacts = EMPTY_WORKFLOW_FACTS,
): ReadonlyArray<DeliverableStateView> {
  const staleCandidateIds = deriveStaleCandidateIds(snapshot, specs, facts);
  // KAN-35: a flagged approval stays approved and keeps its dependents unblocked;
  // the owner decides whether to refresh it.
  const usableApprovedKinds = new Set(facts.approvals.map((a) => a.deliverableKind));
  return specs
    .slice()
    .sort((a, b) => compare(a.agentId, b.agentId))
    .map((spec) => deriveDeliverableState(snapshot, { spec, facts, usableApprovedKinds, staleCandidateIds }));
}

function byCreation(a: WorkflowTask, b: WorkflowTask): number {
  return compare(a.createdAt, b.createdAt) || a.iterationNumber - b.iterationNumber || compare(a.id, b.id);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** FNV-1a 32-bit over the joined parts. Deterministic and dependency-free. */
function tokenOf(parts: ReadonlyArray<string>): string {
  const text = parts.join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ds1-${hash.toString(16).padStart(8, '0')}`;
}
