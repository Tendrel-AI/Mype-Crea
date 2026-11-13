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
  // KAN-27: the caller's accepted terms versions (the fake applies the exact-version rule).
  const acceptedVersions = new Set<string>(['terminos-v1']);
  const hasAccepted = vi.fn(async (version: string) => acceptedVersions.has(version));
  const preflight = vi.fn<(request: unknown) => Promise<any>>(async () => ({ allowed: true, reservationId: null }));
  const pin = vi.fn(async (_id: string, versions: Record<string, string>) => versions);
  const context = { brandId: 'b1', brandName: 'Brisa Ron', productId: null, productName: null };
  const repository = {
    conversations: { ensurePinnedConversation, context: vi.fn(async () => context) }, conversationPrompts: { pin }, aiTurns, messages, usage: { preflight },
    termsAcceptances: { hasAccepted },
    aiConfig: { getPinnedRelease: vi.fn(async () => undefined), getProviderAvailability: vi.fn(async () => ({ enabled: true, version: 0 })) },
  };
  const repos = vi.fn(() => repository);
  const startConversation = vi.fn(async () => { calls.push('startConversation'); });
  const applyDelta = vi.fn(async () => { calls.push('applyDelta'); return { snapshot, rejected: [] }; });
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
  const baselineCalls = { identity: 0, draft: 0 }; // plain counters: survive vi.clearAllMocks
  return {
    baselineCalls,
    calls, pin, identity, turn, snapshot, delta, decision, ensurePinnedConversation, claimTurn,
    ensureUserMessage, checkpointTurn, failTurn, completeTurn, listNotices, listTurns,
    repository, repos, startConversation, applyDelta, peekNextDecision, acknowledgeDecisions,
    getSnapshot, messages, extract, render, runPurpose, childInfo, acceptedVersions, hasAccepted, preflight,
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
  captureRuntimeIdentity: async () => {
    mocks.baselineCalls.identity += 1;
    return { runtimeVersion: '1.0.0', codeFingerprint: 'code', dependencyFingerprint: 'deps' };
  },
  // Stands in for the registry check that rejects untrusted env models.
  createBaselineDraft: async () => {
    mocks.baselineCalls.draft += 1;
    if (process.env.OPENROUTER_EXTRACTOR_MODEL) throw new Error('model_unsupported');
    return { runtimeCompatibility: { min: '1.0.0', max: '1.0.0' } };
  },
}));
vi.mock('../../../src/services/ai-config/provider-registry', () => ({ ProviderRegistry: class {} }));
vi.mock('../../../src/services/logger', () => ({
  loggerFor: () => ({ child: () => ({ info: mocks.childInfo, error: mocks.childInfo }), info: mocks.childInfo, error: mocks.childInfo, warn: mocks.childInfo }),
}));

import { chatAction } from '../chat';
import { CURRENT_TERMS_VERSION, TERMS_REQUIRED_MESSAGE } from '../../../src/consent/terms';

const input = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  userMessage: '  Quiero un logo  ',
};

describe('chatAction durable turn boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.acceptedVersions.clear();
    mocks.acceptedVersions.add('terminos-v1');
    mocks.hasAccepted.mockImplementation(async (version: string) => mocks.acceptedVersions.has(version));
    mocks.preflight.mockResolvedValue({ allowed: true, reservationId: null });
    mocks.listTurns.mockResolvedValue([]);
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

  it('gives the responder the most recent messages in chronological order (KAN-91)', async () => {
    mocks.messages.listByConversation.mockResolvedValueOnce([
      { role: 'assistant', content: 'newest' }, { role: 'user', content: 'older' },
    ] as never);
    await chatAction(input);
    expect(mocks.messages.listByConversation).toHaveBeenCalledWith(expect.anything(), { limit: 10, orderDescending: true });
    expect((mocks.render.mock.calls[0] as unknown as [{ recentMessages: { content: string }[] }])[0].recentMessages.map((m) => m.content)).toEqual(['older', 'newest']);
  });

  it('pins the active prompt versions after authorizing and hands the stored map to both adapters (D22)', async () => {
    const stored = { extractor: 'extractor.v4', responder: 'responder.chat-step1.v5' };
    mocks.pin.mockResolvedValueOnce(stored);
    await chatAction(input);
    expect(mocks.pin).toHaveBeenCalledTimes(1);
    expect(mocks.pin).toHaveBeenCalledWith(input.conversationId, expect.objectContaining({
      extractor: expect.any(String), responder: expect.any(String), 'name-agent': expect.any(String),
      'tagline-agent': expect.any(String), 'logo-agent': expect.any(String),
    }));
    expect(mocks.ensurePinnedConversation.mock.invocationCallOrder[0]).toBeLessThan(mocks.pin.mock.invocationCallOrder[0]);
    expect(mocks.pin.mock.invocationCallOrder[0]).toBeLessThan(mocks.extract.mock.invocationCallOrder[0]);
    expect(mocks.extract).toHaveBeenCalledWith(expect.objectContaining({ promptVersions: stored }));
    expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({ promptVersions: stored }));
    // KAN-93: the Responder gets the brand/product names of the conversation.
    expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ brandName: 'Brisa Ron' }) }));
  });

  describe('KAN-43 usage preflight', () => {
    it('asks for room for a whole turn (two calls) and the input cap before claiming it', async () => {
      await chatAction(input);
      expect(mocks.preflight).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'llm', calls: 2, inputChars: 'Quiero un logo'.length, conversationId: input.conversationId,
      }));
      expect(mocks.preflight.mock.invocationCallOrder[0]).toBeLessThan(mocks.claimTurn.mock.invocationCallOrder[0]);
    });

    it.each([
      ['tenant_credits', 'Tu organización debe recargar créditos. Avísale al administrador de tu organización.'],
      ['user_llm_hourly', 'Alcanzaste el límite de mensajes por hora. Espera un momento e inténtalo de nuevo.'],
      ['input_too_long', 'Tu mensaje es demasiado largo. Escribe hasta 4000 caracteres.'],
    ])('a %s denial returns the Spanish message and leaves no turn and no model call', async (reason, message) => {
      mocks.preflight.mockResolvedValueOnce({ allowed: false, reason, reservationId: 'reservation-1' });
      const result = await chatAction(input);
      expect(result).toMatchObject({ ok: false, code: 'usage_limited', message, retryable: false });
      expect(mocks.claimTurn).not.toHaveBeenCalled();
      expect(mocks.ensureUserMessage).not.toHaveBeenCalled();
      expect(mocks.runPurpose).not.toHaveBeenCalled();
      expect(mocks.applyDelta).not.toHaveBeenCalled();
    });

    it('replays the stored reply of an answered request even while the user is over a limit', async () => {
      await chatAction(input);
      // The first request was answered; now the user is over the hourly limit.
      const answered = { ...mocks.turn, requestId: input.requestId, stage: 'responded', responseContent: '¡Listo!' };
      mocks.listTurns.mockResolvedValue([answered] as never);
      mocks.claimTurn.mockResolvedValue({ kind: 'completed', turn: answered });
      mocks.preflight.mockResolvedValue({ allowed: false, reason: 'user_llm_hourly', reservationId: 'reservation-1' });
      vi.clearAllMocks();

      const retry = await chatAction(input);

      expect(retry).toMatchObject({ ok: true, content: '¡Listo!', requestId: input.requestId });
      expect(mocks.preflight).not.toHaveBeenCalled();
      expect(mocks.runPurpose).not.toHaveBeenCalled();
      expect(mocks.extract).not.toHaveBeenCalled();
      expect(mocks.render).not.toHaveBeenCalled();
    });

    it('still checks a new request in a conversation that has answered ones', async () => {
      mocks.listTurns.mockResolvedValue([{ ...mocks.turn, requestId: 'another-request', stage: 'responded' }] as never);
      mocks.preflight.mockResolvedValueOnce({ allowed: false, reason: 'user_llm_hourly', reservationId: 'reservation-1' });
      const result = await chatAction(input);
      expect(result).toMatchObject({ ok: false, code: 'usage_limited' });
      expect(mocks.claimTurn).not.toHaveBeenCalled();
    });

    it('measures a long message in code points', async () => {
      await chatAction({ ...input, userMessage: '😀'.repeat(4001) });
      expect(mocks.preflight).toHaveBeenCalledWith(expect.objectContaining({ inputChars: 4001 }));
    });
  });

  describe('KAN-27 consent gate', () => {
    const expectNothingProcessed = () => {
      expect(mocks.ensurePinnedConversation).not.toHaveBeenCalled();
      expect(mocks.startConversation).not.toHaveBeenCalled();
      expect(mocks.claimTurn).not.toHaveBeenCalled();
      expect(mocks.ensureUserMessage).not.toHaveBeenCalled();
      expect(mocks.runPurpose).not.toHaveBeenCalled();
      expect(mocks.extract).not.toHaveBeenCalled();
      expect(mocks.render).not.toHaveBeenCalled();
    };

    it('checks the CURRENT terms version for the session identity before any processing', async () => {
      await chatAction(input);
      expect(mocks.hasAccepted).toHaveBeenCalledWith(CURRENT_TERMS_VERSION);
      expect(mocks.repos).toHaveBeenCalledWith(mocks.identity.tenant, mocks.identity.user);
      expect(mocks.hasAccepted.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensurePinnedConversation.mock.invocationCallOrder[0]);
    });

    it('rejects a direct call from a user who never accepted, with no LLM or agent work', async () => {
      mocks.acceptedVersions.clear();
      const result = await chatAction(input);
      expect(result).toMatchObject({ ok: false, code: 'terms_required', message: TERMS_REQUIRED_MESSAGE, retryable: false });
      expectNothingProcessed();
    });

    it('rejects a user who accepted only an older version (version bump forces re-acceptance)', async () => {
      mocks.acceptedVersions.clear();
      mocks.acceptedVersions.add('terminos-v0');
      const result = await chatAction(input);
      expect(result).toMatchObject({ ok: false, code: 'terms_required' });
      expectNothingProcessed();
    });

    it('fails closed when the acceptance cannot be verified', async () => {
      mocks.hasAccepted.mockRejectedValueOnce(new Error('db down'));
      const result = await chatAction(input);
      expect(result).toMatchObject({ ok: false, code: 'terms_unavailable', retryable: true });
      expectNothingProcessed();
    });
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
      kind: 'confirm_fields', entries: [{ agentId: 'logo-agent', fieldName: 'business_name', pendingValue: 'Sazón Andino' }], reason: 'low_confidence',
    };
    const announcements: PlannerDecision[] = [
      { kind: 'announce_dispatch', agentId: 'logo-agent', taskId: 'task-1' },
      { kind: 'announce_completion', agentId: 'logo-agent', taskId: 'task-1', deliverableIds: [], artifacts: [] },
    ];
    // listTurns is newest first: an older confirmation must not shadow the latest one (D35, bug 5).
    const older: PlannerDecision = {
      kind: 'confirm_fields', entries: [{ agentId: 'logo-agent', fieldName: 'visual_references', pendingValue: 'Nike' }], reason: 'low_confidence',
    };
    mocks.listTurns.mockResolvedValue([
      { ...mocks.turn, id: 'turn-0', stage: 'responded', payload: { decisions: [confirm] } },
      { ...mocks.turn, id: 'turn--1', stage: 'responded', payload: { decisions: [older] } },
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

  it('does not validate env model overrides nor re-hash sources per turn', async () => {
    process.env.OPENROUTER_EXTRACTOR_MODEL = 'google/gemini-2.5-flash-lite';
    try {
      const first = await chatAction(input);
      const second = await chatAction(input);
      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: true });
      expect(mocks.baselineCalls.draft).toBe(0);
      expect(mocks.baselineCalls.identity).toBe(1);
    } finally {
      delete process.env.OPENROUTER_EXTRACTOR_MODEL;
    }
  });
});
