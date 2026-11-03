/**
 * MYPES Platform — Deliverable command handler (KAN-28 / KAN-64 / KAN-65)
 * ========================================================================
 *
 * The ONLY path that starts a generation, cancels one, or approves a
 * candidate. The UI renders buttons from the server-derived
 * `allowedCommands`, but that is advisory: every command is re-validated
 * here against a freshly derived `DeliverableStateView` (P0644, P0456).
 *
 * Validation order (first failure wins, nothing is written on a rejection):
 *   1. shape (`invalid`)
 *   2. idempotent replay — an already-applied command id returns the
 *      original outcome with `replayed: true` and never repeats the effect
 *      (task commands are durable through the task idempotency key); the
 *      same id with a different payload is `invalid` (KAN-44)
 *   3. unknown agent (`not_found`)
 *   4. stale view: `expectedState` / `stateToken` differ from the fresh view
 *      (`stale`)
 *   5. command not in the fresh `allowedCommands` (`not_allowed`)
 *   6. command-specific checks (target task / candidate / expected approval)
 *
 * Effects go through ports only: `IDeliverableWorkflowStore` (tasks),
 * `IApprovalStore` (approvals), and a `dispatch` callback that the core
 * implements over `IAgentTransport`. No agent- or field-specific branching:
 * dependents come from the declarative `mypes:deliverable.dependsOn` map.
 *
 * Every rejection message is neutral Latin-American Spanish with «tú».
 */

import {
  type ConversationId,
  type ConversationSnapshot,
  type DeliverableCommand,
  type DeliverableCommandRejection,
  type DeliverableCommandResult,
  type DeliverableStateView,
  type TaskId,
} from '../contracts';
import type { IApprovalStore } from '../approvals';
import {
  REFINEMENT_SNAPSHOT_KEY,
  buildIterationRefinement,
  type IterationRefinement,
} from '../refinement';
import { loggerFor } from '../../services/logger';
import type { DeliverableSpec } from './agent-registry';
import type { CreateTaskInput, IDeliverableWorkflowStore, WorkflowTask } from './deliverable-workflow';
import {
  dependentKindsOf,
  deriveDeliverableStates,
  requirementsFromSnapshot,
  type DeliverableWorkflowFacts,
} from './deliverable-state';
import { UPSTREAM_INPUTS_KEY, UPSTREAM_SNAPSHOT_KEY, type UpstreamInput } from '../deliverable-inputs';

export { requirementsFromSnapshot };

const log = loggerFor('orchestrator.commands');

/** User-facing rejection copy (neutral Latin-American Spanish, tú). */
export const COMMAND_MESSAGES = {
  stale: 'El estado de este entregable cambió. Revisa el panel actualizado e inténtalo de nuevo.',
  notAllowed: 'Esta acción no está disponible en este momento.',
  notFound: 'No encontramos este entregable.',
  invalid: 'No pudimos validar esta acción.',
  cancelTooLate: 'La generación ya empezó y no se puede cancelar.',
  approveNotCandidate: 'Esta propuesta no está disponible para aprobar.',
  approveUnsafe: 'Esta propuesta no pasó la revisión automática de seguridad. Genera otra opción.',
  approveStale: 'La aprobación cambió mientras decidías. Revisa la propuesta aprobada actual e inténtalo de nuevo.',
  iterateNeedsChange: 'Cuéntanos qué quieres cambiar para intentarlo de nuevo.',
  replayConflict: 'Esta acción ya se usó con otros datos. Inténtalo de nuevo desde el panel.',
} as const;

/** Everything the handler needs, already scoped to one conversation's tenant/user. */
export interface DeliverableCommandContext {
  readonly specs: ReadonlyArray<DeliverableSpec>;
  readonly workflow: IDeliverableWorkflowStore;
  readonly approvals: IApprovalStore;
  loadSnapshot(conversationId: ConversationId): Promise<ConversationSnapshot>;
  agentCardVersion(agentId: string): string;
  /**
   * Send the freshly created task through `IAgentTransport` (implemented by
   * the core: records the in-flight marker, dispatches, queues the
   * announcement).
   */
  dispatch(input: {
    readonly conversationId: ConversationId;
    readonly agentId: string;
    readonly task: WorkflowTask;
    readonly requirements: Record<string, unknown>;
    /** Approved upstream values the task was created under (KAN-32). */
    readonly upstream: Readonly<Record<string, UpstreamInput>>;
    readonly refinement: IterationRefinement | null;
  }): Promise<void>;
  /** Clean up the in-flight marker after a successful cancel. */
  onCanceled(input: { readonly conversationId: ConversationId; readonly agentId: string; readonly taskId: TaskId }): Promise<void>;
}

/** Read every fact the pure state function needs for one conversation. */
export async function loadWorkflowFacts(
  ctx: Pick<DeliverableCommandContext, 'workflow' | 'approvals'>,
  conversationId: ConversationId,
): Promise<DeliverableWorkflowFacts> {
  const [tasks, candidates, approvals, markedStaleKinds] = await Promise.all([
    ctx.workflow.listTasks(conversationId),
    ctx.workflow.listCandidates(conversationId),
    ctx.approvals.getApproved(conversationId),
    ctx.approvals.getStaleKinds(conversationId),
  ]);
  return { tasks, candidates, approvals, markedStaleKinds };
}

export async function deriveStatesFor(
  ctx: DeliverableCommandContext,
  conversationId: ConversationId,
): Promise<ReadonlyArray<DeliverableStateView>> {
  const [snapshot, facts] = await Promise.all([
    ctx.loadSnapshot(conversationId),
    loadWorkflowFacts(ctx, conversationId),
  ]);
  return deriveDeliverableStates(snapshot, ctx.specs, facts);
}

type OkExtras = { readonly taskId?: TaskId; readonly approvalId?: string };

/**
 * Stateless handler over a context. Idempotency of non-task commands within
 * a process is provided by the caller's replay cache (see the core); task
 * commands are durably idempotent through the task idempotency key.
 */
export async function executeDeliverableCommand(
  ctx: DeliverableCommandContext,
  command: DeliverableCommand,
): Promise<DeliverableCommandResult> {
  const child = log.child({
    op: 'executeCommand',
    conversationId: command.conversationId,
    agentId: command.agentId,
    kind: command.kind,
    commandId: command.commandId,
  });

  const reject = async (
    reason: DeliverableCommandRejection,
    message: string,
    states?: ReadonlyArray<DeliverableStateView>,
  ): Promise<DeliverableCommandResult> => {
    child.info({ reason }, 'orchestrator.command.rejected');
    return {
      ok: false,
      commandId: command.commandId,
      kind: command.kind,
      reason,
      message,
      states: states ?? (await safeStates(ctx, command.conversationId)),
    };
  };
  const accept = async (replayed: boolean, extras: OkExtras = {}): Promise<DeliverableCommandResult> => {
    child.info({ replayed, ...extras }, 'orchestrator.command.accepted');
    return {
      ok: true,
      commandId: command.commandId,
      kind: command.kind,
      replayed,
      ...extras,
      states: await deriveStatesFor(ctx, command.conversationId),
    };
  };

  // 1. Shape.
  if (typeof command.commandId !== 'string' || command.commandId.length === 0) {
    return reject('invalid', COMMAND_MESSAGES.invalid);
  }
  if (command.kind === 'iterate') {
    // Shape check before any read; the anchor is filled in once it is resolved.
    const shape = buildIterationRefinement({
      observation: command.observation,
      parameterChanges: command.parameterChanges,
      anchorDeliverableId: null,
    });
    if (!shape.ok) return reject('invalid', shape.message);
  }

  // 2. Durable replay of task-creating commands (the command id is the task's idempotency key).
  if (command.kind === 'generate' || command.kind === 'iterate' || command.kind === 'retry') {
    const existing = await ctx.workflow.findTaskByCommandId(command.conversationId, command.commandId);
    if (existing) {
      if (!replayMatches(existing, command)) return reject('invalid', COMMAND_MESSAGES.replayConflict);
      return accept(true, { taskId: existing.id });
    }
  }

  // 3. Unknown agent.
  const spec = ctx.specs.find((s) => s.agentId === command.agentId);
  if (!spec) return reject('not_found', COMMAND_MESSAGES.notFound);

  const [snapshot, facts] = await Promise.all([
    ctx.loadSnapshot(command.conversationId),
    loadWorkflowFacts(ctx, command.conversationId),
  ]);
  const states = deriveDeliverableStates(snapshot, ctx.specs, facts);
  const view = states.find((s) => s.agentId === command.agentId)!;

  // 2b. Replays whose effect is visible in the facts (survive a restart).
  if (command.kind === 'cancel') {
    const target = facts.tasks.find((t) => t.id === command.taskId && t.agentId === command.agentId);
    if (target?.status === 'canceled') return accept(true, { taskId: target.id });
  }
  if (command.kind === 'approve' && view.approvedDeliverableId === command.deliverableId) {
    // Already the approved one: either the replay of a command that already
    // succeeded, or a re-approval of the current candidate. Both are no-ops
    // (KAN-34: re-approving the current deliverable is `ok`, nothing replaced).
    return accept(true);
  }

  // 4. Stale view.
  if (command.expectedState !== view.state || command.stateToken !== view.stateToken) {
    return reject('stale', COMMAND_MESSAGES.stale, states);
  }

  // 5. Allowed by the fresh view.
  if (!view.allowedCommands.includes(command.kind)) {
    return reject('not_allowed', COMMAND_MESSAGES.notAllowed, states);
  }

  // 6. Command-specific.
  switch (command.kind) {
    case 'cancel': {
      if (view.activeTask?.taskId !== command.taskId) return reject('stale', COMMAND_MESSAGES.stale, states);
      const canceled = await ctx.workflow.cancelPendingTask(command.conversationId, command.taskId);
      if (!canceled) return reject('stale', COMMAND_MESSAGES.cancelTooLate);
      await ctx.onCanceled({ conversationId: command.conversationId, agentId: command.agentId, taskId: command.taskId });
      return accept(false, { taskId: command.taskId });
    }

    case 'approve': {
      const target = view.candidates.find((c) => c.deliverableId === command.deliverableId);
      if (!target) return reject('not_found', COMMAND_MESSAGES.approveNotCandidate, states);
      // KAN-33: a rejected or indeterminate safety verdict is never approvable (fail closed).
      if (!target.approvable) return reject('not_allowed', COMMAND_MESSAGES.approveUnsafe, states);
      if (command.expectedApprovedId !== view.approvedDeliverableId) {
        return reject('stale', COMMAND_MESSAGES.approveStale, states);
      }
      // RF-07: the store records the approval and the (transitive) dependents'
      // stale marks in one atomic write (KAN-34), an append-only record of the
      // event. Since KAN-35 the overlay itself is computed from the upstream
      // approvals each dependent task recorded; the marks decide only for
      // older tasks. Nothing is regenerated automatically.
      const result = await ctx.approvals.approve({
        conversationId: command.conversationId,
        deliverableKind: spec.deliverableKind,
        deliverableId: command.deliverableId,
        expectedApprovedId: command.expectedApprovedId,
        dependentKinds: dependentKindsOf(spec.deliverableKind, ctx.specs),
      });
      if (!result.ok) {
        if (result.reason === 'stale') return reject('stale', COMMAND_MESSAGES.approveStale);
        if (result.reason === 'not_candidate') return reject('not_allowed', COMMAND_MESSAGES.approveNotCandidate);
        return reject('not_found', COMMAND_MESSAGES.approveNotCandidate);
      }
      return accept(false, { approvalId: result.approvalId });
    }

    case 'generate':
    case 'iterate':
    case 'retry': {
      let iteration: CreateTaskInput['iteration'];
      let refinement: IterationRefinement | null = null;

      if (command.kind === 'retry') {
        if (view.lastFailure?.taskId !== command.failedTaskId) return reject('stale', COMMAND_MESSAGES.stale, states);
        const failed = facts.tasks.find((t) => t.id === command.failedTaskId)!;
        iteration = chainIteration(facts.tasks, failed, 'failure');
      } else if (command.kind === 'iterate' && view.state === 'failed') {
        // KAN-58: Iterar on a failed deliverable changes the failed request.
        // It chains onto the failed task (trigger `failure`, like Reintentar)
        // with the refinement and no anchor: a failed task has no candidate.
        if (!view.lastFailure) return reject('stale', COMMAND_MESSAGES.stale, states);
        if (command.deliverableId != null) return reject('invalid', COMMAND_MESSAGES.invalid, states);
        const failed = facts.tasks.find((t) => t.id === view.lastFailure!.taskId)!;
        const built = buildIterationRefinement({
          observation: command.observation,
          parameterChanges: command.parameterChanges,
          anchorDeliverableId: null,
        });
        if (!built.ok) return reject('invalid', built.message, states);
        if (built.value.observations.length === 0 && Object.keys(built.value.parameterChanges).length === 0) {
          // An unchanged request is a Reintentar, not an Iterar.
          return reject('invalid', COMMAND_MESSAGES.iterateNeedsChange, states);
        }
        iteration = chainIteration(facts.tasks, failed, 'failure');
        refinement = built.value;
      } else if (command.kind === 'iterate') {
        const anchorId = command.deliverableId ?? view.approvedDeliverableId ?? view.candidates.at(-1)?.deliverableId;
        const anchor = view.candidates.find((c) => c.deliverableId === anchorId);
        if (!anchor) return reject('not_found', COMMAND_MESSAGES.approveNotCandidate, states);
        const parent = facts.tasks.find((t) => t.id === anchor.taskId);
        if (!parent) return reject('invalid', COMMAND_MESSAGES.invalid, states);
        iteration = chainIteration(facts.tasks, parent, 'user_regenerate');
        const built = buildIterationRefinement({
          observation: command.observation,
          parameterChanges: command.parameterChanges,
          anchorDeliverableId: anchor.deliverableId,
        });
        if (!built.ok) return reject('invalid', built.message, states);
        refinement = built.value;
      }

      // Requirements always come from the current brief, never from the client.
      const requirements = requirementsFromSnapshot(snapshot, command.agentId);
      // RF-07 (KAN-35): a stable reference to the upstream approvals this task is
      // generated under. Staleness is later computed against it; it is never rewritten.
      const approvedUpstream = spec.dependsOn.flatMap((kind) => {
        const approved = facts.approvals.find((a) => a.deliverableKind === kind);
        return approved ? [{ kind, deliverableId: approved.deliverableId }] : [];
      });
      const upstream = Object.fromEntries(approvedUpstream.map(({ kind, deliverableId }) => [kind, deliverableId]));
      // KAN-32: the approved upstream's text value is a handler input, recorded with the task.
      // shortcut: only inline text upstreams carry a value; add a URL when an agent consumes an image upstream.
      const upstreamInputs: Record<string, UpstreamInput> = Object.fromEntries(
        approvedUpstream.flatMap(({ kind, deliverableId }) => {
          const value = facts.candidates.find((c) => c.deliverableId === deliverableId)?.contentInline?.value;
          return typeof value === 'string' ? [[kind, { deliverableId, value }]] : [];
        }),
      );
      const requirementsSnapshot: Record<string, unknown> = {
        ...requirements,
        [UPSTREAM_SNAPSHOT_KEY]: upstream,
        ...(Object.keys(upstreamInputs).length > 0 ? { [UPSTREAM_INPUTS_KEY]: upstreamInputs } : {}),
        ...(refinement ? { [REFINEMENT_SNAPSHOT_KEY]: refinement } : {}),
      };

      const created = await ctx.workflow.createTask({
        conversationId: command.conversationId,
        agentId: command.agentId,
        agentCardVersion: ctx.agentCardVersion(command.agentId),
        commandId: command.commandId,
        requirementsSnapshot,
        iteration,
      });
      if (!created.ok) {
        if (created.reason === 'duplicate_command' && replayMatches(created.task, command)) {
          return accept(true, { taskId: created.task.id });
        }
        if (created.reason === 'duplicate_command' || created.reason === 'command_id_conflict') {
          return reject('invalid', COMMAND_MESSAGES.replayConflict);
        }
        return reject('stale', COMMAND_MESSAGES.stale);
      }

      await ctx.dispatch({
        conversationId: command.conversationId,
        agentId: command.agentId,
        task: created.task,
        requirements,
        upstream: upstreamInputs,
        refinement,
      });
      return accept(false, { taskId: created.task.id });
    }
  }
}

/**
 * A replayed task command must name the task it created: same agent, same
 * kind of task (KAN-44).
 * shortcut: an Iterar replay's observation/anchor is not compared durably (it lives in the requirements snapshot); the core's in-process replay cache compares the whole command.
 */
function replayMatches(task: WorkflowTask, command: DeliverableCommand): boolean {
  if (task.agentId !== command.agentId) return false;
  if (command.kind === 'generate') return task.parentTaskId === null;
  if (command.kind === 'retry') return task.parentTaskId === command.failedTaskId;
  return task.parentTaskId !== null;
}

/** What a replay must repeat exactly: the command minus the client's view (KAN-44). */
export function commandFingerprint(command: DeliverableCommand): string {
  const { expectedState: _state, stateToken: _token, ...rest } = command;
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Iteration fields for a new task chained onto `parent`. */
function chainIteration(
  tasks: ReadonlyArray<WorkflowTask>,
  parent: WorkflowTask,
  trigger: 'user_regenerate' | 'failure',
): NonNullable<CreateTaskInput['iteration']> {
  const chain = tasks.filter((t) => t.iterationRootId === parent.iterationRootId);
  const iterationNumber = Math.max(...chain.map((t) => t.iterationNumber), parent.iterationNumber) + 1;
  return {
    parentTaskId: parent.id,
    iterationRootId: parent.iterationRootId,
    iterationNumber,
    trigger,
  };
}

async function safeStates(
  ctx: DeliverableCommandContext,
  conversationId: ConversationId,
): Promise<ReadonlyArray<DeliverableStateView>> {
  try {
    return await deriveStatesFor(ctx, conversationId);
  } catch (err) {
    log.warn({ err, conversationId }, 'orchestrator.command.states_unavailable');
    return [];
  }
}
