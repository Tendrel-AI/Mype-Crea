import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const identity = { tenant: { id: 'tenant-1' }, user: { id: 'user-1' } };
  const pinned = { state: 'pinned', snapshot: { conversationId: 'new-id', agentStates: {} }, releaseId: 'release-1' };
  const ensurePinnedConversation = vi.fn(async (_input?: unknown) => pinned);
  const readPinnedConversation = vi.fn(async (): Promise<typeof pinned | undefined> => pinned);
  const listTurns = vi.fn(async (): Promise<Array<{
    id: string;
    requestId: string;
    inputContent: string;
    responseContent: string | null;
    stage: string;
    failureCategory: string | null;
    createdAt: string;
  }>> => [{
    id: 'turn-1', requestId: 'request-1', inputContent: 'Quiero un logo',
    responseContent: '¡Vamos!', stage: 'responded', failureCategory: null, createdAt: '2026-01-01T00:00:00.000Z',
  }]);
  const listNotices = vi.fn(async () => [{ code: 'approved_fallback_used', content: 'Seguimos con una alternativa.' }]);
  const listAttempts = vi.fn(async () => [{ id: 'attempt-1', provider: 'openrouter', model: 'model-a' }]);
  const listByConversation = vi.fn(async (): Promise<Array<{
    id: string;
    kind: string;
    contentUrl: string | null;
    contentInline: Record<string, unknown> | null;
    storageKey?: string | null;
    selectedAt: string | null;
    createdAt: string;
  }>> => []);
  const listMessages = vi.fn(async () => [{ id: 'message-1', role: 'user', content: 'Quiero un logo' }]);
  const getPinnedRelease = vi.fn(async () => ({ id: 'release-1', contentHash: 'hash-1' }));
  const startConversation = vi.fn(async () => undefined);
  const listRecent = vi.fn(async (): Promise<Array<{
    conversationId: string; startedAt: string; lastActivityAt: string; businessName: string | null; brandId: string | null; productId: string | null;
  }>> => []);
  const timeline = vi.fn(async (): Promise<Record<string, unknown> | undefined> => ({
    conversationId: '11111111-1111-4111-8111-111111111111', access: 'owner', generatedAt: '2026-11-02T15:00:00.000Z',
    events: [{ seq: 1, kind: 'conversation', refId: '11111111-1111-4111-8111-111111111111', meta: {}, content: null }],
  }));
  const brandsCreateConversation = vi.fn(async (input: unknown) => (
    { ok: true as const, pin: await ensurePinnedConversation(input as never) }
  ));
  const listActive = vi.fn(async () => []);
  const context = vi.fn(async (): Promise<unknown> => ({ brandId: '99999999-9999-4999-8999-999999999999', brandName: 'Café Andino', productId: null, productName: null }));
  const repos = vi.fn((..._args: unknown[]) => ({
    brands: { createConversation: brandsCreateConversation, listActive },
    products: { listActive },
    trace: { timeline },
    conversations: { ensurePinnedConversation, readPinnedConversation, listRecent, context },
    messages: { listByConversation: listMessages },
    deliverables: { listByConversation },
    aiConfig: { getPinnedRelease },
    aiTurns: { listTurns, listNotices, listAttempts },
  }));
  const getDeliverableStates = vi.fn(async () => []);
  const executeCommand = vi.fn();
  const applyDelta = vi.fn();
  const getOrchestrator = vi.fn(() => ({ startConversation, getDeliverableStates, executeCommand, applyDelta }));
  const getFieldSchemas = vi.fn(() => []);
  return {
    identity, pinned, ensurePinnedConversation, brandsCreateConversation, readPinnedConversation,
    listTurns, listNotices, listAttempts, listByConversation, listMessages, getPinnedRelease,
    startConversation, repos, getOrchestrator, getFieldSchemas, listRecent, timeline,
    getDeliverableStates, executeCommand, applyDelta, context,
  };
});

vi.mock('../../../src/auth/resolve-identity', () => ({
  resolveIdentity: vi.fn(async () => mocks.identity),
  repositoryActor: vi.fn(() => ({ workosUserId: 'workos-user-1', platformAdmin: false, tenantRole: 'admin' })),
}));
vi.mock('../../../src/repos', () => ({ repos: mocks.repos }));
vi.mock('../../../src/core/orchestrator/runtime', () => ({ getOrchestrator: mocks.getOrchestrator }));
vi.mock('../../../src/core/orchestrator/bootstrap-registry', () => ({
  buildDefaultRegistry: () => ({ getFieldSchemas: mocks.getFieldSchemas }),
}));

import {
  exportConversationTraceAction,
  listConversationsAction,
  loadConversationAction,
} from '../conversations';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const BRAND_ID = '99999999-9999-4999-8999-999999999999';

describe('conversation actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensurePinnedConversation.mockResolvedValue(mocks.pinned);
    mocks.readPinnedConversation.mockResolvedValue(mocks.pinned);
  });

  it('loads owner-scoped durable turns and notices', async () => {
    mocks.listByConversation.mockResolvedValueOnce([{
      id: 'deliverable-1', kind: 'logo', contentUrl: 'https://assets.example/logo.png', contentInline: null,
      selectedAt: '2026-01-01T00:00:05.000Z', createdAt: '2026-01-01T00:00:01.000Z',
    }]);
    const result = await loadConversationAction({ conversationId: CONVERSATION_ID });
    expect(mocks.readPinnedConversation).toHaveBeenCalledWith(CONVERSATION_ID, []);
    expect(result).toMatchObject({
      ok: true,
      turns: [{
        requestId: 'request-1', userMessage: 'Quiero un logo', content: '¡Vamos!',
        notices: [{ code: 'approved_fallback_used', content: 'Seguimos con una alternativa.' }],
      }],
    });
    expect(result).toMatchObject({
      ok: true,
      deliverables: [{
        id: 'deliverable-1', kind: 'logo', contentUrl: 'https://assets.example/logo.png',
        selectedAt: '2026-01-01T00:00:05.000Z',
      }],
    });
    expect(mocks.listByConversation).toHaveBeenCalledWith(CONVERSATION_ID);
  });

  it('exposes a stored image only through the asset route; legacy rows keep their URL (KAN-52)', async () => {
    mocks.listByConversation.mockResolvedValueOnce([
      {
        id: 'deliverable-stored', kind: 'logo', contentUrl: 'https://fal.example/provider.png', contentInline: null,
        storageKey: 'tenants/tenant-1/conversations/c/tasks/t/0.png', selectedAt: null, createdAt: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'deliverable-legacy', kind: 'logo', contentUrl: 'https://assets.example/legacy.png', contentInline: null,
        storageKey: null, selectedAt: null, createdAt: '2026-01-01T00:00:02.000Z',
      },
    ]);
    const result = await loadConversationAction({ conversationId: CONVERSATION_ID });
    if (!result.ok) throw new Error('expected ok');
    expect(result.deliverables.map((d) => d.contentUrl)).toEqual([
      '/api/assets/deliverable-stored',
      'https://assets.example/legacy.png',
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('fal.example');
    expect(serialized).not.toContain('tenants/');
  });

  it('exposes a safe incomplete turn for manual same-request recovery without starting model work', async () => {
    mocks.listTurns.mockResolvedValueOnce([{
      id: 'turn-2', requestId: 'same-request-id', inputContent: 'Quiero un logo',
      responseContent: null, stage: 'effects_committed', failureCategory: null,
      createdAt: '2026-01-02T00:00:00.000Z',
    }]);
    const result = await loadConversationAction({ conversationId: CONVERSATION_ID });
    expect(result).toMatchObject({
      ok: true,
      turns: [{ requestId: 'same-request-id', userMessage: 'Quiero un logo', stage: 'effects_committed' }],
    });
    // KAN-30: the reload only reads durable state (deliverable states included); no model work, no dispatch.
    expect(mocks.getDeliverableStates).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.applyDelta).not.toHaveBeenCalled();
    expect(mocks.listTurns).toHaveBeenCalledWith(CONVERSATION_ID);
  });

  it('returns a clear legacy outcome without reading turns', async () => {
    mocks.readPinnedConversation.mockResolvedValue({ ...mocks.pinned, state: 'legacy_unversioned' });
    const result = await loadConversationAction({ conversationId: '22222222-2222-4222-8222-222222222222' });
    expect(result).toMatchObject({ ok: false, code: 'legacy_unversioned' });
    expect(mocks.listTurns).not.toHaveBeenCalled();
  });

  it('exports the KAN-42 timeline read with the caller identity and actor (owner or tenant admin)', async () => {
    const result = await exportConversationTraceAction({ conversationId: CONVERSATION_ID });
    if (!result.ok) throw new Error('expected ok');
    expect(JSON.parse(result.content)).toMatchObject({ conversationId: CONVERSATION_ID, access: 'owner', events: [{ seq: 1, kind: 'conversation' }] });
    expect(mocks.repos).toHaveBeenCalledWith(mocks.identity.tenant, mocks.identity.user, { workosUserId: 'workos-user-1', platformAdmin: false, tenantRole: 'admin' });
    expect(mocks.timeline).toHaveBeenCalledWith(CONVERSATION_ID);
  });

  it('answers a foreign or missing conversation with the same not-found result, and never reads a malformed id', async () => {
    mocks.timeline.mockResolvedValueOnce(undefined);
    const foreign = await exportConversationTraceAction({ conversationId: CONVERSATION_ID });
    const malformed = await exportConversationTraceAction({ conversationId: 'not-a-uuid' });
    expect(foreign).toEqual(malformed);
    expect(foreign).toMatchObject({ ok: false, code: 'conversation_unavailable' });
    expect(mocks.timeline).toHaveBeenCalledTimes(1);
  });

  it('fails safely when the trace read throws', async () => {
    mocks.timeline.mockRejectedValueOnce(new Error('db down'));
    const result = await exportConversationTraceAction({ conversationId: CONVERSATION_ID });
    expect(result).toEqual({ ok: false, code: 'conversation_unavailable', message: 'No pudimos exportar esta conversación. Inténtalo de nuevo.' });
  });
  it('lists the caller’s recent conversations with server-side labels (KAN-25)', async () => {
    mocks.listRecent.mockResolvedValueOnce([
      { conversationId: CONVERSATION_ID, startedAt: '2026-10-20T15:00:00.000Z', lastActivityAt: '2026-10-24T15:00:00.000Z', businessName: 'Café Andino', brandId: BRAND_ID, productId: null },
      { conversationId: '22222222-2222-4222-8222-222222222222', startedAt: '2026-10-01T15:00:00.000Z', lastActivityAt: '2026-10-01T15:00:00.000Z', businessName: null, brandId: null, productId: null },
    ]);
    const result = await listConversationsAction();
    expect(result).toEqual({
      ok: true,
      brands: [],
      conversations: [
        { conversationId: CONVERSATION_ID, brandId: BRAND_ID, productId: null, label: 'Café Andino · 24 oct', lastActivityAt: '2026-10-24T15:00:00.000Z' },
        { conversationId: '22222222-2222-4222-8222-222222222222', brandId: null, productId: null, label: 'Nueva conversación · 1 oct', lastActivityAt: '2026-10-01T15:00:00.000Z' },
      ],
    });
    expect(mocks.repos).toHaveBeenCalledWith(mocks.identity.tenant, mocks.identity.user);
    expect(mocks.listRecent).toHaveBeenCalledWith();
  });

  it('answers a list failure with safe Spanish copy (KAN-25)', async () => {
    mocks.listRecent.mockRejectedValueOnce(new Error('relation "conversations" does not exist'));
    const result = await listConversationsAction();
    expect(result).toEqual({
      ok: false, code: 'conversations_unavailable', message: 'No pudimos cargar tus conversaciones. Inténtalo de nuevo.',
    });
  });

  it('gives malformed, foreign and missing ids the same not-found answer on direct load (KAN-25)', async () => {
    const malformed = await loadConversationAction({ conversationId: 'conversation-1' });
    mocks.readPinnedConversation.mockResolvedValueOnce(undefined);
    const foreignOrMissing = await loadConversationAction({ conversationId: CONVERSATION_ID });
    expect(malformed).toEqual({ ok: false, code: 'conversation_unavailable', message: 'No encontramos esta conversación.' });
    expect(foreignOrMissing).toEqual(malformed);
    expect(mocks.readPinnedConversation).toHaveBeenCalledTimes(1);
    expect(mocks.listTurns).not.toHaveBeenCalled();
  });

  it('no longer exposes a standalone «new conversation» action (D40 / D44)', async () => {
    expect(await import('../conversations')).not.toHaveProperty('createConversationAction');
  });
});
