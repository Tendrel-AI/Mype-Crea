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
 *      (task commands are durable through the task idempotency key)
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
  type FieldSlot,
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
  type DeliverableWorkflowFacts,
} from './deliverable-state';

const log = loggerFor('orchestrator.commands');

/** User-facing rejection copy (neutral Latin-American Spanish, tú). */
export const COMMAND_MESSAGES = {
  stale: 'El estado de este entregable cambió. Revisa el panel actualizado e inténtalo de nuevo.',
  notAllowed: 'Esta acción no está disponible en este momento.',
  notFound: 'No encontramos este entregable.',
  invalid: 'No pudimos validar esta acción.',
  cancelTooLate: 'La generación ya empezó y no se puede cancelar.',
  approveNotCandidate: 'Esta propuesta no está disponible para aprobar.',
  approveStale: 'La aprobación cambió mientras decidías. Revisa la propuesta aprobada actual e inténtalo de nuevo.',
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
    if (existing) return accept(true, { taskId: existing.id });
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
      if (!view.candidates.some((c) => c.deliverableId === command.deliverableId)) {
        return reject('not_found', COMMAND_MESSAGES.approveNotCandidate, states);
      }
      if (command.expectedApprovedId !== view.approvedDeliverableId) {
        return reject('stale', COMMAND_MESSAGES.approveStale, states);
      }
      // RF-07: a new or replaced approval makes the (transitive) dependents
      // obsolete. The store records the approval and their stale marks in one
      // atomic write (KAN-34), so an approval never stands without its marks.
      // Only approved dependents show the overlay; a later approval of a
      // dependent clears it. Nothing is regenerated automatically.
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
      const requirementsSnapshot: Record<string, unknown> = refinement
        ? { ...requirements, [REFINEMENT_SNAPSHOT_KEY]: refinement }
        : { ...requirements };

      const created = await ctx.workflow.createTask({
        conversationId: command.conversationId,
        agentId: command.agentId,
        agentCardVersion: ctx.agentCardVersion(command.agentId),
        commandId: command.commandId,
        requirementsSnapshot,
        iteration,
      });
      if (!created.ok) {
        if (created.reason === 'duplicate_command') return accept(true, { taskId: created.task.id });
        return reject('stale', COMMAND_MESSAGES.stale);
      }

      await ctx.dispatch({
        conversationId: command.conversationId,
        agentId: command.agentId,
        task: created.task,
        requirements,
        refinement,
      });
      return accept(false, { taskId: created.task.id });
    }
  }
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
