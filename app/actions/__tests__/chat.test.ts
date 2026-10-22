import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannerDecision } from '../../../src/core/contracts';

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const identity = { tenant: { id: 'tenant-1' }, user: { id: 'user-1' } };
  const decision: PlannerDecision = { kind: 'announce_all_complete' };
  const turn = {
    id: 'turn-1', conversationId: 'conversation-1', requestId: 'request-1', inputHash: 'hash',
    inputContent: 'Quiero un logo', responseContent: null as string | null, releaseId: 'release-1', stage: 'reserved',
    version: 1, payload: {}, failureCategory: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const snapshot = { conversationId: 'conversation-1', tenantId: 'tenant-1', agentStates: {}, updatedAt: '2026-01-01T00:00:00.000Z' };
  const delta = { conversationId: 'conversation-1', source: 'chat-es', timestamp: '2026-01-01T00:00:00.000Z', fields: {} };
  const ensurePinnedConversation = vi.fn(async () => ({ state: 'pinned', snapshot, releaseId: 'release-1' }));
  const claimTurn = vi.fn<() => Promise<any>>(async () => ({ kind: 'acquired', turn: { ...turn }, ownerToken: 'owner-1' }));
  const ensureUserMessage = vi.fn(async () => undefined);
  const checkpointTurn = vi.fn(async (input: { stage: string; payload: Record<string, unknown>; expectedVersion: number }) => ({
    ...turn, stage: input.stage, payload: input.payload, version: input.expectedVersion + 1,
  }));
  const failTurn = vi.fn(async () => undefined);
  const completeTurn = vi.fn(async (input: { responseContent: string }) => ({
    turn: { ...turn, stage: 'responded', responseContent: input.responseContent }, notices: [],
  }));
  const listNotices = vi.fn(async () => []);
  const listTurns = vi.fn(async () => []);
  const aiTurns = { claimTurn, ensureUserMessage, checkpointTurn, failTurn, completeTurn, listNotices, listTurns };
  const messages = { listByConversation: vi.fn(async () => [{ role: 'user', content: 'Quiero un logo' }]) };
  const repository = {
    conversations: { ensurePinnedConversation }, aiTurns, messages,
    aiConfig: { getPinnedRelease: vi.fn(async () => undefined), getProviderAvailability: vi.fn(async () => ({ enabled: true, version: 0 })) },
  };
  const repos = vi.fn(() => repository);
  const startConversation = vi.fn(async () => { calls.push('startConversation'); });
  const applyDelta = vi.fn(async () => { calls.push('applyDelta'); return snapshot; });
  const peekNextDecision = vi.fn(async (): Promise<PlannerDecision[]> => [decision]);
  const acknowledgeDecisions = vi.fn(async () => { calls.push('acknowledgeDecisions'); });
  const getSnapshot = vi.fn(async () => snapshot);
  const extract = vi.fn(async () => { calls.push('extract'); return delta; });
  const render = vi.fn(async () => { calls.push('render'); return { content: '¡Listo!' }; });
  const runPurpose = vi.fn(async (_identity: unknown, input: { purpose: string }, operation: (execution: unknown) => Promise<unknown>) => {
    calls.push(`run:${input.purpose}`);
    const value = await operation({ model: {}, behavior: {} });
    return { value, effectiveProfileId: 'profile-1' };
  });
  const childInfo = vi.fn();
  return {
    calls, identity, turn, snapshot, delta, decision, ensurePinnedConversation, claimTurn,
    ensureUserMessage, checkpointTurn, failTurn, completeTurn, listNotices, listTurns,
    repository, repos, startConversation, applyDelta, peekNextDecision, acknowledgeDecisions,
    getSnapshot, extract, render, runPurpose, childInfo,
  };
});

vi.mock('../../../src/auth/resolve-identity', () => ({ resolveIdentity: vi.fn(async () => mocks.identity) }));
vi.mock('../../../src/repos', () => ({ repos: mocks.repos }));
vi.mock('../../../src/core/orchestrator/bootstrap-registry', () => ({
  buildDefaultRegistry: () => ({ getFieldSchemas: () => [] }),
}));
vi.mock('../../../src/core/orchestrator/runtime', () => ({
  getOrchestrator: () => ({ startConversation: mocks.startConversation, applyDelta: mocks.applyDelta, peekNextDecision: mocks.peekNextDecision, acknowledgeDecisions: mocks.acknowledgeDecisions, getSnapshot: mocks.getSnapshot }),
  getChatInputAdapter: () => ({ extract: mocks.extract }),
  getChatOutputAdapter: () => ({ render: mocks.render }),
}));
vi.mock('../../../src/services/ai-config/execution', () => ({
  AiConfigRuntime: class { runPurpose = mocks.runPurpose; },
  AiConfigExecutionError: class extends Error {
    category = 'ambiguous_provider_outcome'; correlationId = 'corr'; ambiguous = true; retryable = false;
  },
}));
vi.mock('../../../src/services/ai-config/baseline', () => ({
  captureSourceIdentity: async () => ({ codeFingerprint: 'code', dependencyFingerprint: 'deps' }),
  createBaselineDraft: async () => ({ runtimeCompatibility: { min: '1.0.0', max: '1.0.0' } }),
}));
vi.mock('../../../src/services/ai-config/provider-registry', () => ({ ProviderRegistry: class {} }));
vi.mock('../../../src/services/logger', () => ({
  loggerFor: () => ({ child: () => ({ info: mocks.childInfo, error: mocks.childInfo }), info: mocks.childInfo, error: mocks.childInfo }),
}));

import { chatAction } from '../chat';

const input = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  userMessage: '  Quiero un logo  ',
};

describe('chatAction durable turn boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.ensurePinnedConversation.mockResolvedValue({ state: 'pinned', snapshot: mocks.snapshot, releaseId: 'release-1' });
    mocks.claimTurn.mockResolvedValue({ kind: 'acquired', turn: { ...mocks.turn }, ownerToken: 'owner-1' });
    mocks.completeTurn.mockImplementation(async ({ responseContent }) => ({
      turn: { ...mocks.turn, stage: 'responded', responseContent }, notices: [],
    }));
    mocks.runPurpose.mockImplementation(async (_identity, runInput, operation) => {
      mocks.calls.push(`run:${runInput.purpose}`);
      return { value: await operation({ model: {}, behavior: {} }), effectiveProfileId: 'profile-1' };
    });
    mocks.extract.mockImplementation(async () => { mocks.calls.push('extract'); return mocks.delta; });
    mocks.render.mockImplementation(async () => { mocks.calls.push('render'); return { content: '¡Listo!' }; });
    mocks.checkpointTurn.mockImplementation(async ({ stage, payload, expectedVersion }) => ({
      ...mocks.turn, stage, payload, version: expectedVersion + 1,
    }));
  });

  it('pins and authorizes before core state, checkpoints effects before apply, then commits reply', async () => {
    const result = await chatAction(input);
    expect(result).toMatchObject({ ok: true, content: '¡Listo!', requestId: input.requestId });
    expect(mocks.calls).toEqual(['startConversation', 'run:extractor', 'extract', 'applyDelta', 'acknowledgeDecisions', 'run:responder', 'render']);
    expect(mocks.ensurePinnedConversation.mock.invocationCallOrder[0]).toBeLessThan(mocks.startConversation.mock.invocationCallOrder[0]);
    expect(mocks.ensureUserMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'Quiero un logo' }));
    expect(mocks.checkpointTurn.mock.calls.map(([value]) => value.stage)).toEqual(['extracted', 'effects_started', 'effects_committed']);
    expect(mocks.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ responseContent: '¡Listo!' }));
  });

  it('returns a stored result for a duplicate completed request without invoking adapters', async () => {
    mocks.claimTurn.mockResolvedValue({ kind: 'completed', turn: { ...mocks.turn, stage: 'responded', responseContent: 'Guardado' } });
    const result = await chatAction(input);
    expect(result).toMatchObject({ ok: true, content: 'Guardado' });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('resumes a committed turn at the responder without repeating extraction or effects', async () => {
    mocks.claimTurn.mockResolvedValue({
      kind: 'acquired',
      ownerToken: 'owner-1',
      turn: { ...mocks.turn, stage: 'effects_committed', version: 4, payload: { decisions: [mocks.decision] } },
    });
    const result = await chatAction(input);
    expect(result).toMatchObject({ ok: true, content: '¡Listo!' });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.applyDelta).not.toHaveBeenCalled();
    // The committed plan already owns its announcements; resuming neither
    // re-reads nor re-acknowledges the core queues (KAN-55).
    expect(mocks.peekNextDecision).not.toHaveBeenCalled();
    expect(mocks.acknowledgeDecisions).not.toHaveBeenCalled();
    expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({ decisions: [mocks.decision] }));
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });

  it('takes the prior confirmation from the persisted turn and reads the core plan once, after effects (KAN-55)', async () => {
    const confirm: PlannerDecision = {
      kind: 'confirm_field', agentId: 'logo-agent', fieldName: 'business_name', pendingValue: 'Sazón Andino', reason: 'low_confidence',
    };
    const announcements: PlannerDecision[] = [
      { kind: 'announce_dispatch', agentId: 'logo-agent', taskId: 'task-1' },
      { kind: 'announce_completion', agentId: 'logo-agent', taskId: 'task-1', deliverableIds: [], artifacts: [] },
    ];
    mocks.listTurns.mockResolvedValueOnce([
      { ...mocks.turn, id: 'turn-0', stage: 'responded', payload: { decisions: [confirm] } },
    ] as never);
    mocks.peekNextDecision.mockImplementationOnce(async () => {
      mocks.calls.push('peekNextDecision');
      return announcements;
    });

    const result = await chatAction({ ...input, userMessage: 'sí' });

    expect(result).toMatchObject({ ok: true });
    expect(mocks.extract).toHaveBeenCalledWith(expect.objectContaining({ priorDecision: confirm }));
    // No core read before extraction: the only plan read follows applyDelta.
    expect(mocks.calls).toEqual([
      'startConversation', 'run:extractor', 'extract', 'applyDelta', 'peekNextDecision',
      'acknowledgeDecisions', 'run:responder', 'render',
    ]);
    expect(mocks.peekNextDecision).toHaveBeenCalledTimes(1);
    const committed = mocks.checkpointTurn.mock.calls.find(([value]) => value.stage === 'effects_committed')?.[0];
    expect(committed?.payload['decisions']).toEqual(announcements);
    expect(mocks.checkpointTurn.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(mocks.acknowledgeDecisions.mock.invocationCallOrder[0]);
    expect(mocks.acknowledgeDecisions).toHaveBeenCalledWith(input.conversationId, announcements);
    expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({ decisions: announcements }));
  });

  it('returns typed contention and does not call adapters for an active duplicate', async () => {
    mocks.claimTurn.mockResolvedValue({ kind: 'in_progress', turn: { ...mocks.turn } });
    const result = await chatAction(input);
    expect(result).toMatchObject({ ok: false, code: 'turn_in_progress' });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('rejects an unversioned conversation before touching core or providers', async () => {
    mocks.ensurePinnedConversation.mockResolvedValue({ state: 'legacy_unversioned', snapshot: mocks.snapshot, releaseId: null } as never);
    const result = await chatAction(input);
    expect(result).toMatchObject({ ok: false, code: 'legacy_unversioned' });
    expect(mocks.startConversation).not.toHaveBeenCalled();
    expect(mocks.claimTurn).not.toHaveBeenCalled();
  });

  it('requires a UUID request id and never sends untrusted text to the browser as an error', async () => {
    const invalid = await chatAction({ ...input, requestId: 'bad' });
    expect(invalid).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(mocks.claimTurn).not.toHaveBeenCalled();
  });
});
