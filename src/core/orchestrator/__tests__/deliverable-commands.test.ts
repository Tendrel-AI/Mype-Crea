/**
 * executeDeliverableCommand — the only path that starts, cancels, or approves
 * (KAN-28 / KAN-64 / KAN-65). Covers each command allowed and forbidden,
 * stale rejection, idempotent replay, Cancelar only while pending, Iterar /
 * Reintentar iteration rows, Aprobar replace with dependents marked stale in
 * the same atomic write (a failed mark rolls the approval back), and that
 * nothing is dispatched without a command.
 */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  AgentRequirementState,
  ConversationId,
  ConversationSnapshot,
  DeliverableCommand,
  DeliverableCommandResult,
  DeliverableId,
  DeliverableStateView,
  TaskId,
} from '../../contracts';
import { InMemoryApprovalStore } from '../../approvals';
import type { DeliverableSpec } from '../agent-registry';
import {
  COMMAND_MESSAGES,
  deriveStatesFor,
  executeDeliverableCommand,
  type DeliverableCommandContext,
} from '../deliverable-commands';
import { InMemoryDeliverableWorkflowStore } from '../deliverable-workflow';
import { REFINEMENT_MESSAGES } from '../../refinement';

const CONVERSATION = '00000000-0000-0000-0000-0000000000c1' as ConversationId;
const TENANT = '00000000-0000-0000-0000-000000000001';

const LOGO: DeliverableSpec = { agentId: 'logo-agent', deliverableKind: 'logo', requiredFields: ['business_name'], dependsOn: [] };
const LABEL: DeliverableSpec = { agentId: 'label-agent', deliverableKind: 'label', requiredFields: [], dependsOn: ['logo'] };
const SOCIAL: DeliverableSpec = { agentId: 'social-agent', deliverableKind: 'social_pack', requiredFields: [], dependsOn: ['label'] };

function agentState(filled: boolean): AgentRequirementState {
  return {
    requiredFields: {
      business_name: filled ? { status: 'filled', value: 'Sazón Andino', confidence: 1 } : { status: 'empty' },
    },
    optionalFields: {},
    iterationCount: 0,
  };
}

function harness(options: { specs?: DeliverableSpec[]; filled?: boolean } = {}) {
  const specs = options.specs ?? [LOGO];
  let filled = options.filled ?? true;
  const workflow = new InMemoryDeliverableWorkflowStore();
  const approvals = new InMemoryApprovalStore({
    kindOf: async (conversationId, deliverableId) =>
      (await workflow.listCandidates(conversationId as ConversationId)).find((c) => c.deliverableId === deliverableId)
        ?.kind ?? null,
  });
  const approveSpy = vi.spyOn(approvals, 'approve');
  const dispatch = vi.fn<DeliverableCommandContext['dispatch']>(async () => {});
  const onCanceled = vi.fn<DeliverableCommandContext['onCanceled']>(async () => {});
  const ctx: DeliverableCommandContext = {
    specs,
    workflow,
    approvals,
    loadSnapshot: async (): Promise<ConversationSnapshot> => ({
      conversationId: CONVERSATION,
      tenantId: TENANT,
      agentStates: Object.fromEntries(specs.map((s) => [s.agentId, agentState(filled)])),
      updatedAt: '2026-10-25T00:00:00.000Z',
    }),
    agentCardVersion: () => '1.0.0',
    dispatch,
    onCanceled,
  };

  const view = async (agentId = 'logo-agent'): Promise<DeliverableStateView> => {
    return (await deriveStatesFor(ctx, CONVERSATION)).find((s) => s.agentId === agentId)!;
  };

  /** Issue a command against the current view (fresh expectedState / token). */
  const run = async (
    partial: Record<string, unknown> & { kind: DeliverableCommand['kind'] },
    agentId = 'logo-agent',
    commandId: string = randomUUID(),
  ): Promise<DeliverableCommandResult> => {
    const current = await view(agentId);
    return executeDeliverableCommand(ctx, {
      commandId,
      conversationId: CONVERSATION,
      agentId,
      expectedState: current.state,
      stateToken: current.stateToken,
      ...partial,
    } as DeliverableCommand);
  };

  const complete = async (taskId: TaskId, kind = 'logo', agentId = 'logo-agent'): Promise<DeliverableId> => {
    const result = await workflow.recordSettlement({
      conversationId: CONVERSATION,
      taskId,
      agentId,
      deliverableKind: kind,
      status: 'completed',
      artifacts: [{ kind: 'image', url: `https://cdn.test/${taskId}.png` }],
      deliverableIds: [],
    });
    return result.deliverableIds[0];
  };

  const fail = async (taskId: TaskId, errorCategory: 'transient' | 'permanent_bug' | 'content_policy') => {
    await workflow.recordSettlement({
      conversationId: CONVERSATION,
      taskId,
      agentId: 'logo-agent',
      deliverableKind: 'logo',
      status: 'failed',
      artifacts: [],
      deliverableIds: [],
      error: { kind: 'synthetic', message: 'synthetic' },
      errorCategory,
    });
  };

  /** Generate + complete -> one candidate in review. */
  const reviewed = async (agentId = 'logo-agent', kind = 'logo') => {
    const generated = await run({ kind: 'generate' }, agentId);
    if (!generated.ok) throw new Error(generated.message);
    const deliverableId = await complete(generated.taskId!, kind, agentId);
    return { taskId: generated.taskId!, deliverableId };
  };

  return {
    ctx,
    workflow,
    approvals,
    approveSpy,
    dispatch,
    onCanceled,
    view,
    run,
    complete,
    fail,
    reviewed,
    setFilled: (value: boolean) => {
      filled = value;
    },
  };
}

function okOf(result: DeliverableCommandResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result;
}

describe('executeDeliverableCommand — Generar', () => {
  it('creates a root task and dispatches it once, with requirements from the brief', async () => {
    const h = harness();
    const result = okOf(await h.run({ kind: 'generate' }));
    expect(result.replayed).toBe(false);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0][0]).toMatchObject({
      agentId: 'logo-agent',
      requirements: { business_name: 'Sazón Andino' },
      refinement: null,
      task: { id: result.taskId, parentTaskId: null, iterationNumber: 1, iterationTrigger: null },
    });
    expect(result.states[0]).toMatchObject({ state: 'generating', allowedCommands: ['cancel'] });
  });

  it('is not allowed while blocked (missing brief field)', async () => {
    const h = harness({ filled: false });
    const result = await h.run({ kind: 'generate' });
    expect(result).toMatchObject({ ok: false, reason: 'not_allowed', message: COMMAND_MESSAGES.notAllowed });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('is not allowed while a task is active or once a candidate is in review', async () => {
    const h = harness();
    okOf(await h.run({ kind: 'generate' }));
    expect(await h.run({ kind: 'generate' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    const [task] = await h.workflow.listTasks(CONVERSATION);
    await h.complete(task.id);
    expect(await h.run({ kind: 'generate' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale state token or expected state with neutral Spanish and the fresh states', async () => {
    const h = harness();
    const fresh = await h.view();
    const byToken = await executeDeliverableCommand(h.ctx, {
      kind: 'generate',
      commandId: randomUUID(),
      conversationId: CONVERSATION,
      agentId: 'logo-agent',
      expectedState: 'enabled',
      stateToken: 'ds1-deadbeef',
    });
    expect(byToken).toMatchObject({ ok: false, reason: 'stale', message: COMMAND_MESSAGES.stale });
    expect(byToken.states).toEqual([fresh]);

    const byState = await executeDeliverableCommand(h.ctx, {
      kind: 'generate',
      commandId: randomUUID(),
      conversationId: CONVERSATION,
      agentId: 'logo-agent',
      expectedState: 'blocked',
      stateToken: fresh.stateToken,
    });
    expect(byState).toMatchObject({ ok: false, reason: 'stale' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('replaying the same command id returns the same task without a second row or dispatch', async () => {
    const h = harness();
    const commandId = randomUUID();
    const first = okOf(await h.run({ kind: 'generate' }, 'logo-agent', commandId));
    // The replay carries the old (now stale) view; replay wins over staleness.
    const replay = okOf(
      await executeDeliverableCommand(h.ctx, {
        kind: 'generate',
        commandId,
        conversationId: CONVERSATION,
        agentId: 'logo-agent',
        expectedState: 'enabled',
        stateToken: 'ds1-old',
      }),
    );
    expect(replay).toMatchObject({ replayed: true, taskId: first.taskId });
    expect(await h.workflow.listTasks(CONVERSATION)).toHaveLength(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown agent and an empty command id', async () => {
    const h = harness();
    const unknown = await executeDeliverableCommand(h.ctx, {
      kind: 'generate',
      commandId: randomUUID(),
      conversationId: CONVERSATION,
      agentId: 'ghost-agent',
      expectedState: 'enabled',
      stateToken: 'x',
    });
    expect(unknown).toMatchObject({ ok: false, reason: 'not_found', message: COMMAND_MESSAGES.notFound });
    expect(await h.run({ kind: 'generate' }, 'logo-agent', '')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('maps a concurrent active task (guard past validation) to stale without dispatching', async () => {
    const h = harness();
    const current = await h.view();
    vi.spyOn(h.workflow, 'createTask').mockResolvedValueOnce({ ok: false, reason: 'active_task_exists' });
    const result = await executeDeliverableCommand(h.ctx, {
      kind: 'generate',
      commandId: randomUUID(),
      conversationId: CONVERSATION,
      agentId: 'logo-agent',
      expectedState: current.state,
      stateToken: current.stateToken,
    });
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

describe('executeDeliverableCommand — Cancelar', () => {
  it('cancels only while pending and returns to enabled', async () => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    const result = okOf(await h.run({ kind: 'cancel', taskId }));
    expect(result.replayed).toBe(false);
    expect(h.onCanceled).toHaveBeenCalledWith({ conversationId: CONVERSATION, agentId: 'logo-agent', taskId });
    expect(result.states[0]).toMatchObject({ state: 'enabled', allowedCommands: ['generate'] });
    expect((await h.workflow.listTasks(CONVERSATION))[0].status).toBe('canceled');
  });

  it('is not allowed once the task was claimed (in_progress)', async () => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    await h.workflow.markInProgress(CONVERSATION, taskId!);
    expect((await h.view()).allowedCommands).toEqual([]);
    expect(await h.run({ kind: 'cancel', taskId })).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(h.onCanceled).not.toHaveBeenCalled();
  });

  it('reports «too late» when the worker claims the task between validation and the write', async () => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    vi.spyOn(h.workflow, 'cancelPendingTask').mockResolvedValueOnce(false);
    expect(await h.run({ kind: 'cancel', taskId })).toMatchObject({
      ok: false,
      reason: 'stale',
      message: COMMAND_MESSAGES.cancelTooLate,
    });
  });

  it('rejects a cancel aimed at another task', async () => {
    const h = harness();
    okOf(await h.run({ kind: 'generate' }));
    expect(await h.run({ kind: 'cancel', taskId: randomUUID() })).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('is not allowed when nothing is generating', async () => {
    const h = harness();
    expect(await h.run({ kind: 'cancel', taskId: randomUUID() })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('replaying a cancel after it applied is an ok no-op', async () => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    const before = await h.view();
    okOf(await h.run({ kind: 'cancel', taskId }));
    const replay = okOf(
      await executeDeliverableCommand(h.ctx, {
        kind: 'cancel',
        taskId: taskId!,
        commandId: randomUUID(),
        conversationId: CONVERSATION,
        agentId: 'logo-agent',
        expectedState: before.state,
        stateToken: before.stateToken,
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(h.onCanceled).toHaveBeenCalledTimes(1);
  });
});

describe('executeDeliverableCommand — Iterar', () => {
  it('chains an iteration (trigger user_regenerate) anchored to a candidate with the refinement stored', async () => {
    const h = harness();
    const { taskId: rootId, deliverableId } = await h.reviewed();
    const result = okOf(await h.run({ kind: 'iterate', deliverableId, observation: '  Más colores cálidos  ' }));
    const tasks = await h.workflow.listTasks(CONVERSATION);
    const iteration = tasks.find((t) => t.id === result.taskId)!;
    expect(iteration).toMatchObject({
      parentTaskId: rootId,
      iterationRootId: rootId,
      iterationNumber: 2,
      iterationTrigger: 'user_regenerate',
    });
    expect(h.workflow.requirementsOf(result.taskId!)).toEqual({
      business_name: 'Sazón Andino',
      refinement: { parameterChanges: {}, observations: ['Más colores cálidos'], anchorDeliverableId: deliverableId },
    });
    // The handler receives the refinement separately from the brief requirements.
    expect(h.dispatch.mock.calls.at(-1)![0]).toMatchObject({
      requirements: { business_name: 'Sazón Andino' },
      refinement: { observations: ['Más colores cálidos'], anchorDeliverableId: deliverableId },
    });
  });

  it('defaults the anchor to the newest candidate, and a blank observation stores none', async () => {
    const h = harness();
    const { taskId: rootId, deliverableId } = await h.reviewed();
    const result = okOf(await h.run({ kind: 'iterate', observation: '   ' }));
    expect(h.workflow.requirementsOf(result.taskId!)?.refinement).toEqual({
      parameterChanges: {},
      observations: [],
      anchorDeliverableId: deliverableId,
    });
    expect((await h.workflow.listTasks(CONVERSATION)).find((t) => t.id === result.taskId)?.parentTaskId).toBe(rootId);
  });

  it('numbers iterations along the chain', async () => {
    const h = harness();
    const { deliverableId } = await h.reviewed();
    const second = okOf(await h.run({ kind: 'iterate', deliverableId }));
    await h.complete(second.taskId!);
    const third = okOf(await h.run({ kind: 'iterate' }));
    const row = (await h.workflow.listTasks(CONVERSATION)).find((t) => t.id === third.taskId)!;
    expect(row).toMatchObject({ parentTaskId: second.taskId, iterationNumber: 3 });
  });

  it('rejects an observation over 500 code points before any write', async () => {
    const h = harness();
    await h.reviewed();
    const result = await h.run({ kind: 'iterate', observation: 'é'.repeat(501) });
    expect(result).toMatchObject({ ok: false, reason: 'invalid', message: REFINEMENT_MESSAGES.observationTooLong });
    expect(h.dispatch).toHaveBeenCalledTimes(1); // only the initial Generar
  });

  it('accepts exactly 500 code points (astral characters count once)', async () => {
    const h = harness();
    await h.reviewed();
    okOf(await h.run({ kind: 'iterate', observation: '🎨'.repeat(500) }));
  });

  it('maps a parent the store refuses (guard past validation) to stale without dispatching', async () => {
    const h = harness();
    await h.reviewed();
    const dispatchedBefore = h.dispatch.mock.calls.length;
    vi.spyOn(h.workflow, 'createTask').mockResolvedValueOnce({ ok: false, reason: 'parent_unavailable' });
    const result = await h.run({ kind: 'iterate', observation: 'Más azul' });
    expect(result).toMatchObject({ ok: false, reason: 'stale', message: COMMAND_MESSAGES.stale });
    expect(h.dispatch).toHaveBeenCalledTimes(dispatchedBefore);
  });

  it('rejects an anchor that is not a candidate of this deliverable', async () => {
    const h = harness();
    await h.reviewed();
    expect(await h.run({ kind: 'iterate', deliverableId: randomUUID() })).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('is not allowed before any candidate exists or when the brief lost a required field', async () => {
    const h = harness();
    expect(await h.run({ kind: 'iterate' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    await h.reviewed();
    h.setFilled(false);
    expect(await h.run({ kind: 'iterate' })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });
});

describe('executeDeliverableCommand — Reintentar', () => {
  it.each(['transient', 'permanent_bug', 'content_policy'] as const)(
    'chains a retry (trigger failure) onto a %s failure (KAN-58: never a dead end)',
    async (category) => {
      const h = harness();
      const { taskId } = okOf(await h.run({ kind: 'generate' }));
      await h.fail(taskId!, category);
      expect((await h.view()).allowedCommands).toContain('retry');
      const retry = okOf(await h.run({ kind: 'retry', failedTaskId: taskId }));
      const row = (await h.workflow.listTasks(CONVERSATION)).find((t) => t.id === retry.taskId)!;
      expect(row).toMatchObject({ parentTaskId: taskId, iterationRootId: taskId, iterationNumber: 2, iterationTrigger: 'failure' });
      expect(h.workflow.requirementsOf(retry.taskId!)).not.toHaveProperty('refinement');
    },
  );

  it('is not allowed while the brief is incomplete', async () => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    await h.fail(taskId!, 'permanent_bug');
    h.setFilled(false);
    expect((await h.view()).allowedCommands).toEqual([]);
    expect(await h.run({ kind: 'retry', failedTaskId: taskId })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('rejects a retry aimed at a task other than the last failure', async () => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    await h.fail(taskId!, 'transient');
    expect(await h.run({ kind: 'retry', failedTaskId: randomUUID() })).toMatchObject({ ok: false, reason: 'stale' });
  });
});

describe('executeDeliverableCommand — Iterar after a failure (KAN-58)', () => {
  it('chains an iteration (trigger failure) onto a content_policy failure with no anchor', async () => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    await h.fail(taskId!, 'content_policy');
    expect((await h.view()).allowedCommands).toEqual(['iterate', 'retry']);
    const result = okOf(await h.run({ kind: 'iterate', observation: 'Sin la mascota, solo letras' }));
    const row = (await h.workflow.listTasks(CONVERSATION)).find((t) => t.id === result.taskId)!;
    expect(row).toMatchObject({ parentTaskId: taskId, iterationRootId: taskId, iterationNumber: 2, iterationTrigger: 'failure' });
    expect(h.workflow.requirementsOf(result.taskId!)).toEqual({
      business_name: 'Sazón Andino',
      refinement: { parameterChanges: {}, observations: ['Sin la mascota, solo letras'], anchorDeliverableId: null },
    });
  });

  it('chains onto a failed iteration that follows a candidate (still no anchor)', async () => {
    const h = harness();
    await h.reviewed();
    const iteration = okOf(await h.run({ kind: 'iterate', observation: 'Más rojo' }));
    await h.fail(iteration.taskId!, 'content_policy');
    const result = okOf(await h.run({ kind: 'iterate', observation: 'Mejor un tono vino' }));
    const row = (await h.workflow.listTasks(CONVERSATION)).find((t) => t.id === result.taskId)!;
    expect(row).toMatchObject({ parentTaskId: iteration.taskId, iterationNumber: 3, iterationTrigger: 'failure' });
    expect(h.workflow.requirementsOf(result.taskId!)?.refinement).toMatchObject({ anchorDeliverableId: null });
  });

  it('rejects an empty change before any write', async () => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    await h.fail(taskId!, 'content_policy');
    const result = await h.run({ kind: 'iterate', observation: '   ' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid', message: COMMAND_MESSAGES.iterateNeedsChange });
    expect(h.dispatch).toHaveBeenCalledTimes(1); // only the initial Generar
  });

  it('rejects an anchor: a failed state has no candidate to refine', async () => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    await h.fail(taskId!, 'content_policy');
    const result = await h.run({ kind: 'iterate', deliverableId: randomUUID(), observation: 'Más azul' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['transient', 'permanent_bug'] as const)('is not offered after a %s failure (Reintentar is)', async (category) => {
    const h = harness();
    const { taskId } = okOf(await h.run({ kind: 'generate' }));
    await h.fail(taskId!, category);
    expect((await h.view()).allowedCommands).toEqual(['retry']);
    expect(await h.run({ kind: 'iterate', observation: 'Más azul' })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });
});

describe('executeDeliverableCommand — Aprobar', () => {
  it('approves a candidate, replaces it with another, and rejects a stale expectedApprovedId', async () => {
    const h = harness();
    const first = await h.reviewed();
    const iteration = okOf(await h.run({ kind: 'iterate', deliverableId: first.deliverableId }));
    const second = await h.complete(iteration.taskId!);

    const approved = okOf(await h.run({ kind: 'approve', deliverableId: first.deliverableId, expectedApprovedId: null }));
    expect(approved.approvalId).toBeTruthy();
    expect(approved.states[0]).toMatchObject({
      state: 'approved',
      approvedDeliverableId: first.deliverableId,
      allowedCommands: ['iterate', 'approve'],
    });

    const stale = await h.run({ kind: 'approve', deliverableId: second, expectedApprovedId: null });
    expect(stale).toMatchObject({ ok: false, reason: 'stale', message: COMMAND_MESSAGES.approveStale });

    okOf(await h.run({ kind: 'approve', deliverableId: second, expectedApprovedId: first.deliverableId }));
    expect((await h.view()).approvedDeliverableId).toBe(second);
    expect(h.approvals.historyFor(CONVERSATION).map((r) => r.replacedDeliverableId)).toEqual([null, first.deliverableId]);
    expect(h.dispatch).toHaveBeenCalledTimes(2); // Generar + Iterar; approving never generates
  });

  it('re-approving the current candidate is an ok no-op (replayed) and writes nothing', async () => {
    const h = harness();
    const { deliverableId } = await h.reviewed();
    okOf(await h.run({ kind: 'approve', deliverableId, expectedApprovedId: null }));
    const again = okOf(await h.run({ kind: 'approve', deliverableId, expectedApprovedId: deliverableId }));
    expect(again.replayed).toBe(true);
    expect(h.approvals.historyFor(CONVERSATION)).toHaveLength(1);
  });

  it('rejects a deliverable that is not a candidate of this type', async () => {
    const h = harness();
    await h.reviewed();
    expect(await h.run({ kind: 'approve', deliverableId: randomUUID(), expectedApprovedId: null })).toMatchObject({
      ok: false,
      reason: 'not_found',
      message: COMMAND_MESSAGES.approveNotCandidate,
    });
  });

  it('is not allowed while generating or without candidates', async () => {
    const h = harness();
    expect(await h.run({ kind: 'approve', deliverableId: randomUUID(), expectedApprovedId: null })).toMatchObject({
      ok: false,
      reason: 'not_allowed',
    });
  });

  it('marks the transitive dependents stale through the declarative map (and shows obsoleto only on approved ones)', async () => {
    const h = harness({ specs: [LOGO, LABEL, SOCIAL] });
    const logo1 = await h.reviewed('logo-agent', 'logo');
    okOf(await h.run({ kind: 'approve', deliverableId: logo1.deliverableId, expectedApprovedId: null }));
    // One call carries the approval and the dependents to mark stale (one atomic write).
    expect(h.approveSpy).toHaveBeenLastCalledWith({
      conversationId: CONVERSATION,
      deliverableKind: 'logo',
      deliverableId: logo1.deliverableId,
      expectedApprovedId: null,
      dependentKinds: ['label', 'social_pack'],
    });

    const label = await h.reviewed('label-agent', 'label');
    okOf(await h.run({ kind: 'approve', deliverableId: label.deliverableId, expectedApprovedId: null }, 'label-agent'));
    expect((await h.view('label-agent')).stale).toBe(false);

    // Replace the logo approval -> the approved label becomes obsoleto, nothing regenerates.
    const iteration = okOf(await h.run({ kind: 'iterate' }));
    const logo2 = await h.complete(iteration.taskId!);
    const dispatchesBefore = h.dispatch.mock.calls.length;
    okOf(await h.run({ kind: 'approve', deliverableId: logo2, expectedApprovedId: logo1.deliverableId }));
    expect(h.approveSpy.mock.calls.map(([input]) => input.dependentKinds)).toEqual([
      ['label', 'social_pack'], // logo
      ['social_pack'], // label
      ['label', 'social_pack'], // logo again
    ]);
    expect(await h.approvals.getStaleKinds(CONVERSATION)).toEqual(['label', 'social_pack']);
    const labelView = await h.view('label-agent');
    expect(labelView).toMatchObject({ state: 'approved', stale: true });
    expect(labelView.allowedCommands).toContain('generate');
    expect(h.dispatch.mock.calls.length).toBe(dispatchesBefore);
  });

  it('passes no dependents and marks nothing when nothing depends on the kind', async () => {
    const h = harness();
    const { deliverableId } = await h.reviewed();
    okOf(await h.run({ kind: 'approve', deliverableId, expectedApprovedId: null }));
    expect(h.approveSpy).toHaveBeenCalledWith(expect.objectContaining({ dependentKinds: [] }));
    expect(await h.approvals.getStaleKinds(CONVERSATION)).toEqual([]);
  });

  it('a failure while writing the stale marks rolls the approval back (approve + marks are atomic)', async () => {
    const h = harness({ specs: [LOGO, LABEL, SOCIAL] });
    const logo1 = await h.reviewed('logo-agent', 'logo');
    okOf(await h.run({ kind: 'approve', deliverableId: logo1.deliverableId, expectedApprovedId: null }));
    const label = await h.reviewed('label-agent', 'label');
    okOf(await h.run({ kind: 'approve', deliverableId: label.deliverableId, expectedApprovedId: null }, 'label-agent'));
    const iteration = okOf(await h.run({ kind: 'iterate' }));
    const logo2 = await h.complete(iteration.taskId!);

    const historyBefore = h.approvals.historyFor(CONVERSATION);
    const staleBefore = await h.approvals.getStaleKinds(CONVERSATION);
    const viewsBefore = await deriveStatesFor(h.ctx, CONVERSATION);

    // The first mark is staged, then the write fails mid-way.
    const stage = vi
      .spyOn(h.approvals as unknown as { stageStaleMarks(s: Set<string>, k: string, d: ReadonlyArray<string>): void }, 'stageStaleMarks')
      .mockImplementationOnce((staged, _kind, dependents) => {
        staged.add(dependents[0]);
        throw new Error('synthetic stale-mark failure');
      });
    await expect(
      h.run({ kind: 'approve', deliverableId: logo2, expectedApprovedId: logo1.deliverableId }),
    ).rejects.toThrow('synthetic stale-mark failure');
    expect(stage).toHaveBeenCalledTimes(1);

    // Nothing changed: same approval, same trail, no marks, same views and tokens.
    expect(h.approvals.historyFor(CONVERSATION)).toEqual(historyBefore);
    expect(await h.approvals.getStaleKinds(CONVERSATION)).toEqual(staleBefore);
    expect((await h.view()).approvedDeliverableId).toBe(logo1.deliverableId);
    expect((await h.view('label-agent')).stale).toBe(false);
    expect(await deriveStatesFor(h.ctx, CONVERSATION)).toEqual(viewsBefore);

    // Retrying the same approval once the store recovers applies both writes.
    okOf(await h.run({ kind: 'approve', deliverableId: logo2, expectedApprovedId: logo1.deliverableId }));
    expect((await h.view()).approvedDeliverableId).toBe(logo2);
    expect(await h.approvals.getStaleKinds(CONVERSATION)).toEqual(['label', 'social_pack']);
    expect((await h.view('label-agent')).stale).toBe(true);
  });

  it('the in-memory store refuses a dependent equal to the approved kind without writing anything', async () => {
    const h = harness();
    const { deliverableId } = await h.reviewed();
    await expect(
      h.approvals.approve({
        conversationId: CONVERSATION,
        deliverableKind: 'logo',
        deliverableId,
        expectedApprovedId: null,
        dependentKinds: ['label', 'logo'],
      }),
    ).rejects.toThrow('cannot depend on itself');
    expect(h.approvals.historyFor(CONVERSATION)).toEqual([]);
    expect(await h.approvals.getApproved(CONVERSATION)).toEqual([]);
    expect(await h.approvals.getStaleKinds(CONVERSATION)).toEqual([]);
  });
});

describe('executeDeliverableCommand — no dispatch without a command', () => {
  it('reading states, rejections, approvals and cancels never dispatch', async () => {
    const h = harness();
    await h.view();
    await h.run({ kind: 'retry', failedTaskId: randomUUID() });
    await h.run({ kind: 'approve', deliverableId: randomUUID(), expectedApprovedId: null });
    await h.run({ kind: 'cancel', taskId: randomUUID() });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(await h.workflow.listTasks(CONVERSATION)).toHaveLength(0);
  });
});
