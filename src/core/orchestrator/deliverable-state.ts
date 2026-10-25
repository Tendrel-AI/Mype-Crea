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
 *              approved (or its approval is stale)          → no commands
 *   enabled    preconditions met, no active task, no candidate yet
 *                                                            → generate
 *   generating latest task pending / in_progress             → cancel (pending only)
 *   in_review  ≥1 candidate, none approved                   → iterate, approve
 *   approved   one approved candidate                        → iterate, approve(other)
 *   failed     latest task failed                            → FAILURE_RECOVERY_COMMANDS
 *              by category (KAN-58: never a dead end): retry for every
 *              category, plus iterate for content_policy
 *   stale      overlay on approved: the approval store holds a stale mark
 *              for this kind newer than its approval (written atomically when
 *              an upstream kind is approved or replaced)    → iterate, generate,
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
} from '../contracts';
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
   * the kind's newest approval). The only source of «obsoleto».
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
 * Pure staleness rule (RF-07 overlay): an approved kind is stale exactly when
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

export interface DeriveDeliverableStateInput {
  readonly spec: DeliverableSpec;
  readonly facts: DeliverableWorkflowFacts;
  /** Kinds approved and not stale (upstream gate). */
  readonly usableApprovedKinds: ReadonlySet<string>;
  readonly staleKinds: ReadonlySet<string>;
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
    if (preconditionsMet && input.staleKinds.has(spec.deliverableKind)) allowed.add('generate');
  } else if (candidates.length > 0) {
    state = 'in_review';
    allowed.add('approve');
    if (preconditionsMet) allowed.add('iterate');
  } else if (preconditionsMet) {
    state = 'enabled';
    allowed.add('generate');
  } else {
    state = 'blocked';
  }

  const stale = state === 'approved' && input.staleKinds.has(spec.deliverableKind);
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
  const staleKinds = deriveStaleKinds(facts.approvals, facts.markedStaleKinds);
  const usableApprovedKinds = new Set(
    facts.approvals.map((a) => a.deliverableKind).filter((kind) => !staleKinds.has(kind)),
  );
  return specs
    .slice()
    .sort((a, b) => compare(a.agentId, b.agentId))
    .map((spec) => deriveDeliverableState(snapshot, { spec, facts, usableApprovedKinds, staleKinds }));
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
