import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const identity = { tenant: { id: 'tenant-1' }, user: { id: 'user-1' } };
  const pinned = { state: 'pinned', snapshot: { conversationId: 'new-id' }, releaseId: 'release-1' };
  const ensurePinnedConversation = vi.fn(async () => pinned);
  const readPinnedConversation = vi.fn(async () => pinned);
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
  const listByConversation = vi.fn(async (): Promise<Array<{
    kind: string;
    contentUrl: string | null;
    contentInline: Record<string, unknown> | null;
  }>> => []);
  const startConversation = vi.fn(async () => undefined);
  const repos = vi.fn(() => ({
    conversations: { ensurePinnedConversation, readPinnedConversation },
    deliverables: { listByConversation },
    aiTurns: { listTurns, listNotices },
  }));
  const getOrchestrator = vi.fn(() => ({ startConversation }));
  const getFieldSchemas = vi.fn(() => []);
  return {
    identity, pinned, ensurePinnedConversation, readPinnedConversation,
    listTurns, listNotices, listByConversation, startConversation, repos, getOrchestrator, getFieldSchemas,
  };
});

vi.mock('../../../src/auth/resolve-identity', () => ({ resolveIdentity: vi.fn(async () => mocks.identity) }));
vi.mock('../../../src/repos', () => ({ repos: mocks.repos }));
vi.mock('../../../src/core/orchestrator/runtime', () => ({ getOrchestrator: mocks.getOrchestrator }));
vi.mock('../../../src/core/orchestrator/bootstrap-registry', () => ({
  buildDefaultRegistry: () => ({ getFieldSchemas: mocks.getFieldSchemas }),
}));

import { createConversationAction, loadConversationAction } from '../conversations';

describe('conversation actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensurePinnedConversation.mockResolvedValue(mocks.pinned);
    mocks.readPinnedConversation.mockResolvedValue(mocks.pinned);
  });

  it('pins the new owner-scoped conversation before registering it with core', async () => {
    const result = await createConversationAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mocks.ensurePinnedConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: result.conversationId,
      schemas: [],
    }));
    expect(mocks.startConversation).toHaveBeenCalledWith(result.conversationId, 'tenant-1', 'user-1');
    expect(mocks.ensurePinnedConversation.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.startConversation.mock.invocationCallOrder[0]);
    expect(mocks.repos).toHaveBeenCalledWith(mocks.identity.tenant, mocks.identity.user);
  });

  it('does not register a legacy conversation with core', async () => {
    mocks.ensurePinnedConversation.mockResolvedValue({ ...mocks.pinned, state: 'legacy_unversioned' });
    const result = await createConversationAction();
    expect(result).toMatchObject({ ok: false, code: 'configuration_unavailable' });
    expect(mocks.startConversation).not.toHaveBeenCalled();
  });

  it('loads owner-scoped durable turns and notices', async () => {
    mocks.listByConversation.mockResolvedValueOnce([{
      kind: 'logo', contentUrl: 'https://assets.example/logo.png', contentInline: null,
    }]);
    const result = await loadConversationAction({ conversationId: 'conversation-1' });
    expect(mocks.readPinnedConversation).toHaveBeenCalledWith('conversation-1', []);
    expect(result).toMatchObject({
      ok: true,
      turns: [{
        requestId: 'request-1', userMessage: 'Quiero un logo', content: '¡Vamos!',
        notices: [{ code: 'approved_fallback_used', content: 'Seguimos con una alternativa.' }],
      }],
    });
    expect(result).toMatchObject({
      ok: true,
      deliverables: [{ kind: 'logo', contentUrl: 'https://assets.example/logo.png' }],
    });
    expect(mocks.listByConversation).toHaveBeenCalledWith('conversation-1');
  });

  it('exposes a safe incomplete turn for manual same-request recovery without starting model work', async () => {
    mocks.listTurns.mockResolvedValueOnce([{
      id: 'turn-2', requestId: 'same-request-id', inputContent: 'Quiero un logo',
      responseContent: null, stage: 'effects_committed', failureCategory: null,
      createdAt: '2026-01-02T00:00:00.000Z',
    }]);
    const result = await loadConversationAction({ conversationId: 'conversation-1' });
    expect(result).toMatchObject({
      ok: true,
      turns: [{ requestId: 'same-request-id', userMessage: 'Quiero un logo', stage: 'effects_committed' }],
    });
    expect(mocks.getOrchestrator).not.toHaveBeenCalled();
    expect(mocks.listTurns).toHaveBeenCalledWith('conversation-1');
  });

  it('returns a clear legacy outcome without reading turns', async () => {
    mocks.readPinnedConversation.mockResolvedValue({ ...mocks.pinned, state: 'legacy_unversioned' });
    const result = await loadConversationAction({ conversationId: 'old-id' });
    expect(result).toMatchObject({ ok: false, code: 'legacy_unversioned' });
    expect(mocks.listTurns).not.toHaveBeenCalled();
  });
});
