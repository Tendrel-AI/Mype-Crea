import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const identity = { tenant: { id: 't1' }, user: { id: 'u1' } };
  return {
    identity,
    authorizeConversation: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, identity })),
    context: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ brandId: 'b1', productId: 'p1' })),
    listBrandApprovedElsewhere: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    latest: vi.fn(async (..._a: unknown[]): Promise<string | undefined> => undefined),
  };
});
vi.mock('../conversation-access', () => ({
  authorizeConversation: mocks.authorizeConversation,
  isUuid: (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v),
}));
vi.mock('../../../src/repos', () => ({
  repos: () => ({
    conversations: { context: mocks.context, latestBrandConversationId: mocks.latest },
    deliverables: { listBrandApprovedElsewhere: mocks.listBrandApprovedElsewhere },
  }),
}));

import { loadBrandAssetsAction } from '../brand-assets';

const CONV = '33333333-3333-4333-8333-333333333333';

describe('loadBrandAssetsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listBrandApprovedElsewhere.mockResolvedValue([]);
    mocks.latest.mockResolvedValue(undefined);
  });

  it('owner: returns approved logo (asset route), name, tagline and the brand chat', async () => {
    mocks.listBrandApprovedElsewhere.mockResolvedValue([
      { id: 'd1', kind: 'logo', contentUrl: 'https://provider/x.png', storageKey: 'k', contentInline: null, artifactMetadata: null },
      { id: 'd2', kind: 'business_name', contentUrl: null, contentInline: { value: 'Café Andino' } },
      { id: 'd3', kind: 'tagline', contentUrl: null, contentInline: { value: 'Sabor de altura' } },
    ]);
    mocks.latest.mockResolvedValue('brand-chat');
    expect(await loadBrandAssetsAction({ conversationId: CONV })).toEqual({
      ok: true, brandId: 'b1', logoUrl: '/api/assets/d1', name: 'Café Andino', tagline: 'Sabor de altura', brandConversationId: 'brand-chat',
    });
  });

  it('missing assets come back as null', async () => {
    const result = await loadBrandAssetsAction({ conversationId: CONV });
    expect(result).toMatchObject({ ok: true, logoUrl: null, name: null, tagline: null, brandConversationId: null });
  });

  it('foreign conversation is refused and reads nothing', async () => {
    mocks.authorizeConversation.mockResolvedValueOnce({ ok: false, code: 'conversation_unavailable', message: 'No encontramos esta conversación.' });
    expect(await loadBrandAssetsAction({ conversationId: CONV })).toEqual({ ok: false, message: 'No encontramos esta conversación.' });
    expect(mocks.listBrandApprovedElsewhere).not.toHaveBeenCalled();
  });

  it('malformed id is refused before authorizing', async () => {
    expect((await loadBrandAssetsAction({ conversationId: 'x' })).ok).toBe(false);
    expect(mocks.authorizeConversation).not.toHaveBeenCalled();
  });
});
