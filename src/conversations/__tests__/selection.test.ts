/**
 * KAN-25 selection: which conversation `/` opens and what a foreign id gets.
 * The fake repository applies the same owner rule as RLS + the explicit
 * tenant/owner predicates (rows are visible only to their tenant AND user), so
 * foreign-user, foreign-tenant and missing ids all look the same to the code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredConversation {
  id: string;
  tenantId: string;
  userId: string;
  state: 'pinned' | 'legacy_unversioned';
  lastActivityAt: string;
  businessName: string | null;
  /** Persisted `agent_states` (the brief), as `loadSnapshot` reifies it. */
  agentStates?: Record<string, unknown>;
}

const OWN = { tenant: { id: 'tenant-a' }, user: { id: 'user-a' } };
const ids = {
  latest: '11111111-1111-4111-8111-111111111111',
  older: '22222222-2222-4222-8222-222222222222',
  legacy: '33333333-3333-4333-8333-333333333333',
  otherUser: '44444444-4444-4444-8444-444444444444',
  otherTenant: '55555555-5555-4555-8555-555555555555',
  missing: '66666666-6666-4666-8666-666666666666',
  created: '77777777-7777-4777-8777-777777777777',
};

const mocks = vi.hoisted(() => ({
  identity: { current: undefined as unknown },
  store: [] as StoredConversation[],
  listRecent: vi.fn(),
  readPinnedConversation: vi.fn(),
  ensurePinnedConversation: vi.fn(),
  brandLimit: { current: undefined as number | undefined },
  productLimit: { current: undefined as number | undefined },
  productCreate: vi.fn(),
  brandCreate: vi.fn(),
  listTurns: vi.fn(),
  listNotices: vi.fn(),
  listByConversation: vi.fn(),
  startConversation: vi.fn(async () => undefined),
  getDeliverableStates: vi.fn(async (): Promise<unknown[]> => []),
  executeCommand: vi.fn(),
  resolveIdentity: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => '77777777-7777-4777-8777-777777777777',
}));
vi.mock('../../auth/resolve-identity', () => ({ resolveIdentity: mocks.resolveIdentity }));
vi.mock('../../core/orchestrator/runtime', () => ({
  getOrchestrator: () => ({
    startConversation: mocks.startConversation,
    getDeliverableStates: mocks.getDeliverableStates,
    executeCommand: mocks.executeCommand,
  }),
}));
vi.mock('../../core/orchestrator/bootstrap-registry', () => ({
  buildDefaultRegistry: () => ({ getFieldSchemas: () => [] }),
}));
const BRAND = '88888888-8888-4888-8888-888888888888';
const PRODUCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRAND_ATTRIBUTES = { business_name: 'Café Andino', business_category: 'Café', market_proposition: 'Café de altura', target_audience: 'Jóvenes' };
const PRODUCT_ATTRIBUTES = { product_name: 'Café molido', food_denomination: 'Café tostado y molido', package_type: 'Bolsa', product_presentations: [{ label: '250 g', principal: true }] };
async function pin(tenant: { id: string }, user: { id: string }, input: { conversationId: string }) {
  await mocks.ensurePinnedConversation(tenant, user, input);
  mocks.store.push({
    id: input.conversationId, tenantId: tenant.id, userId: user.id, state: 'pinned',
    lastActivityAt: '2026-10-25T12:00:00.000Z', businessName: null,
  });
  return { conversationId: input.conversationId, state: 'pinned', releaseId: 'release-1', snapshot: { agentStates: {} } };
}

vi.mock('../../repos', () => ({
  repos: (tenant: { id: string }, user: { id: string }) => {
    const visible = (row: StoredConversation) => row.tenantId === tenant.id && row.userId === user.id;
    return {
      conversations: {
        listRecent: (limit = 20) => mocks.listRecent(tenant, user, limit).then(() => mocks.store
          .filter((row) => visible(row) && row.state === 'pinned')
          .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
          .slice(0, limit)
          .map((row) => ({
            conversationId: row.id, startedAt: row.lastActivityAt, lastActivityAt: row.lastActivityAt, businessName: row.businessName, brandId: null, productId: null,
          }))),
        context: async () => ({ brandId: BRAND, brandName: 'Café Andino', productId: null, productName: null }),
        readPinnedConversation: async (conversationId: string) => {
          await mocks.readPinnedConversation(tenant, user, conversationId);
          const row = mocks.store.find((candidate) => candidate.id === conversationId && visible(candidate));
          return row
            ? { conversationId, state: row.state, releaseId: row.state === 'pinned' ? 'release-1' : null, snapshot: { agentStates: row.agentStates ?? {} } }
            : undefined;
        },
      },
      brands: {
        listActive: async () => [{ id: BRAND, name: 'Café Andino' }],
        create: async (input: { firstConversation: { conversationId: string } }) => {
          mocks.brandCreate(tenant, user, input);
          if (mocks.brandLimit.current !== undefined) return { ok: false, code: 'brand_limit_reached', limit: mocks.brandLimit.current };
          return { ok: true, brandId: BRAND, pin: await pin(tenant, user, input.firstConversation) };
        },
        createConversation: async (input: { brandId: string; conversationId: string }) => {
          if (input.brandId !== BRAND) return { ok: false, code: 'brand_not_found' };
          return { ok: true, pin: await pin(tenant, user, input) };
        },
      },
      products: {
        listActive: async () => [{ id: PRODUCT, brandId: BRAND, name: 'Café molido' }],
        create: async (input: { brandId: string; firstConversation: { conversationId: string } }) => {
          mocks.productCreate(tenant, user, input);
          if (mocks.productLimit.current !== undefined) return { ok: false, code: 'product_limit_reached', limit: mocks.productLimit.current };
          if (input.brandId !== BRAND) return { ok: false, code: 'brand_not_found' };
          return { ok: true, product: { id: PRODUCT }, pin: await pin(tenant, user, input.firstConversation) };
        },
      },
      aiTurns: {
        listTurns: mocks.listTurns,
        listNotices: mocks.listNotices,
      },
      deliverables: { listByConversation: mocks.listByConversation },
    };
  },
}));

import {
  CONVERSATION_NOT_FOUND_MESSAGE,
  createOwnedBrand,
  createOwnedConversation,
  createOwnedProduct,
  isConversationId,
  listOwnedConversations,
  resolveHomeConversation,
} from '../selection';

function seed(): StoredConversation[] {
  return [
    { id: ids.older, tenantId: 'tenant-a', userId: 'user-a', state: 'pinned', lastActivityAt: '2026-10-20T15:00:00.000Z', businessName: null },
    {
      id: ids.latest, tenantId: 'tenant-a', userId: 'user-a', state: 'pinned', lastActivityAt: '2026-10-24T15:00:00.000Z', businessName: 'Café Andino',
      agentStates: {
        'logo-agent': {
          requiredFields: { business_name: { status: 'filled', value: 'Café Andino', confidence: 0.95, source: 'chat-es' } },
          optionalFields: { color_palette: { status: 'filled', value: 'verde y crema', confidence: 1, source: 'brief-panel' } },
          iterationCount: 0,
        },
      },
    },
    // Newest of all, but legacy: never listed, never resumed.
    { id: ids.legacy, tenantId: 'tenant-a', userId: 'user-a', state: 'legacy_unversioned', lastActivityAt: '2026-10-25T09:00:00.000Z', businessName: 'Antigua' },
    // Same tenant, another member.
    { id: ids.otherUser, tenantId: 'tenant-a', userId: 'user-b', state: 'pinned', lastActivityAt: '2026-10-25T10:00:00.000Z', businessName: 'Ajena' },
    // Another tenant (same user id on purpose: the tenant axis alone must hide it).
    { id: ids.otherTenant, tenantId: 'tenant-b', userId: 'user-a', state: 'pinned', lastActivityAt: '2026-10-25T11:00:00.000Z', businessName: 'Otra empresa' },
  ];
}

const OWN_LIST = [
  { conversationId: ids.latest, brandId: null, productId: null, label: 'Café Andino · 24 oct', lastActivityAt: '2026-10-24T15:00:00.000Z' },
  { conversationId: ids.older, brandId: null, productId: null, label: 'Nueva conversación · 20 oct', lastActivityAt: '2026-10-20T15:00:00.000Z' },
];

describe('resolveHomeConversation (KAN-25)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store = seed();
    mocks.resolveIdentity.mockResolvedValue(OWN);
    mocks.listRecent.mockResolvedValue(undefined);
    mocks.readPinnedConversation.mockResolvedValue(undefined);
    mocks.ensurePinnedConversation.mockResolvedValue(undefined);
    mocks.listTurns.mockResolvedValue([{
      id: 'turn-1', requestId: 'request-1', inputContent: 'Quiero un logo', responseContent: '¡Vamos!',
      stage: 'responded', failureCategory: null, createdAt: '2026-10-24T15:00:00.000Z',
    }]);
    mocks.listNotices.mockResolvedValue([]);
    mocks.listByConversation.mockResolvedValue([{
      id: 'deliverable-1', kind: 'logo', contentUrl: 'https://assets.example/logo.png', contentInline: null,
      storageKey: null, selectedAt: null, createdAt: '2026-10-24T15:00:01.000Z',
    }]);
  });

  it('without an id, resumes the most recent own pinned conversation by last activity', async () => {
    const result = await resolveHomeConversation(undefined);
    expect(result).toEqual({ kind: 'redirect', conversationId: ids.latest });
    expect(mocks.listRecent).toHaveBeenCalledWith(OWN.tenant, OWN.user, 1);
    expect(mocks.ensurePinnedConversation).not.toHaveBeenCalled();
    expect(mocks.startConversation).not.toHaveBeenCalled();
  });

  it('without an id and with no resumable conversation (only legacy or foreign rows), shows the empty state and creates nothing (KAN-87)', async () => {
    mocks.store = seed().filter((row) => row.id !== ids.latest && row.id !== ids.older);
    const result = await resolveHomeConversation(undefined);
    expect(result).toEqual({ kind: 'empty', brands: [{ brandId: BRAND, name: 'Café Andino', products: [{ productId: PRODUCT, name: 'Café molido' }] }] });
    expect(mocks.brandCreate).not.toHaveBeenCalled();
    expect(mocks.startConversation).not.toHaveBeenCalled();
  });

  it('opens an own conversation with its history, deliverables and the own list', async () => {
    const result = await resolveHomeConversation(ids.older);
    expect(result).toMatchObject({
      kind: 'open',
      history: {
        conversationId: ids.older,
        context: { brandId: BRAND, brandName: 'Café Andino', productId: null },
        turns: [{ requestId: 'request-1', userMessage: 'Quiero un logo', content: '¡Vamos!', stage: 'responded' }],
        deliverables: [{ id: 'deliverable-1', kind: 'logo', contentUrl: 'https://assets.example/logo.png' }],
      },
      conversations: OWN_LIST,
    });
    expect(mocks.listTurns).toHaveBeenCalledWith(ids.older);
  });

  it('KAN-30: a reload restores the task in progress and the deliverables from durable state, without dispatching anything', async () => {
    const generating = { agentId: 'logo-agent', state: 'generating', activeTask: { taskId: 'task-2', status: 'in_progress', iteration: 2 }, candidates: [{ deliverableId: 'deliverable-1' }] };
    mocks.getDeliverableStates.mockResolvedValueOnce([generating]);
    const result = await resolveHomeConversation(ids.older);
    expect(result).toMatchObject({ kind: 'open', history: { states: [generating] } });
    expect(mocks.startConversation).toHaveBeenCalledWith(ids.older, 'tenant-a', 'user-a');
    expect(mocks.getDeliverableStates).toHaveBeenCalledWith(ids.older);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('KAN-30: states that cannot be read leave the rest of the reload intact (the client reloads them)', async () => {
    mocks.getDeliverableStates.mockRejectedValueOnce(new Error('db down'));
    const result = await resolveHomeConversation(ids.older);
    expect(result).toMatchObject({ kind: 'open', history: { states: [], turns: [{ requestId: 'request-1' }] } });
  });

  it('resumes a conversation with its persisted brief, as the panel shows it', async () => {
    const result = await resolveHomeConversation(ids.latest);
    expect(result.kind).toBe('open');
    const brief = result.kind === 'open' ? result.history.brief : [];
    expect(brief.find((field) => field.name === 'business_name')).toMatchObject({ status: 'filled', value: 'Café Andino', source: 'chat' });
    expect(brief.find((field) => field.name === 'color_palette')).toMatchObject({ status: 'filled', value: 'verde y crema', source: 'panel' });
    expect(brief.find((field) => field.name === 'location')).toMatchObject({ status: 'empty', value: null });
  });

  it('gives foreign-user, foreign-tenant, missing, malformed and legacy ids one identical not-found result', async () => {
    const requested: Array<string | string[]> = [
      ids.otherUser,
      ids.otherTenant,
      ids.missing,
      'not-a-uuid',
      '',
      `${ids.latest}' OR '1'='1`,
      [ids.latest, ids.older],
      ids.legacy,
    ];
    const results = [];
    for (const id of requested) results.push(await resolveHomeConversation(id));
    const expected = { kind: 'not_found', message: CONVERSATION_NOT_FOUND_MESSAGE, conversations: OWN_LIST, brands: [{ brandId: BRAND, name: 'Café Andino', products: [{ productId: PRODUCT, name: 'Café molido' }] }] };
    for (const result of results) expect(result).toEqual(expected);
    expect(CONVERSATION_NOT_FOUND_MESSAGE).toBe('No encontramos esta conversación.');
    // Nothing of the foreign conversations is ever read.
    expect(mocks.listTurns).not.toHaveBeenCalled();
    expect(mocks.listByConversation).not.toHaveBeenCalled();
    // Malformed values never reach SQL; well-formed ones are checked by the owner-scoped repo.
    const reachedRepo = mocks.readPinnedConversation.mock.calls.map(([, , id]) => id);
    expect(reachedRepo).toEqual([ids.otherUser, ids.otherTenant, ids.missing, ids.legacy]);
    for (const [tenant, user] of mocks.readPinnedConversation.mock.calls) {
      expect(tenant).toEqual(OWN.tenant);
      expect(user).toEqual(OWN.user);
    }
    expect(JSON.stringify(results)).not.toMatch(/Ajena|Otra empresa|Antigua/);
  });

  it('starting a new conversation keeps the previous one listed', async () => {
    const created = await createOwnedConversation(OWN as never, BRAND as never);
    expect(created).toMatchObject({ ok: true, conversationId: ids.created, brandId: BRAND });
    const list = await listOwnedConversations(OWN as never);
    expect(list.map((entry) => entry.conversationId)).toEqual([ids.created, ids.latest, ids.older]);
    expect(list[0].label).toBe('Nueva conversación · 25 oct');
  });

  it('fails closed without an identity and reads nothing', async () => {
    mocks.resolveIdentity.mockRejectedValueOnce(new Error('no session'));
    const result = await resolveHomeConversation(ids.latest);
    expect(result).toMatchObject({ kind: 'error' });
    expect(mocks.readPinnedConversation).not.toHaveBeenCalled();
    expect(mocks.listRecent).not.toHaveBeenCalled();
  });

  it('a brand whose first conversation cannot be pinned throws before core starts (the action answers configuration_unavailable)', async () => {
    mocks.ensurePinnedConversation.mockImplementationOnce(async () => { throw new Error('no release'); });
    await expect(createOwnedBrand(OWN as never, { attributes: BRAND_ATTRIBUTES })).rejects.toThrow('no release');
    expect(mocks.startConversation).not.toHaveBeenCalled();
  });
});

describe('brand and product creation (KAN-87)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.brandLimit.current = undefined;
    mocks.productLimit.current = undefined;
  });

  it('createOwnedBrand: invalid attributes return per-field errors and nothing is created', async () => {
    const result = await createOwnedBrand(OWN as never, { attributes: { business_name: 'Solo nombre' } });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input', fieldErrors: { business_category: expect.any(String), market_proposition: expect.any(String) } });
    expect(mocks.brandCreate).not.toHaveBeenCalled();
    expect(mocks.startConversation).not.toHaveBeenCalled();
  });

  it('createOwnedBrand: returns the typed refusal at the limit, else the brand plus first conversation and the header context', async () => {
    mocks.brandLimit.current = 3;
    expect(await createOwnedBrand(OWN as never, { attributes: BRAND_ATTRIBUTES })).toMatchObject({ ok: false, code: 'brand_limit_reached', limit: 3 });
    mocks.brandLimit.current = undefined;
    expect(await createOwnedBrand(OWN as never, { attributes: BRAND_ATTRIBUTES })).toMatchObject({
      ok: true, conversationId: ids.created, brandId: BRAND, productId: null, context: { brandName: 'Café Andino' },
    });
    expect(mocks.startConversation).toHaveBeenCalledTimes(1);
    expect(mocks.brandCreate).toHaveBeenLastCalledWith(OWN.tenant, OWN.user, expect.objectContaining({ name: 'Café Andino', attributes: BRAND_ATTRIBUTES }));
  });

  it('import mode stores imported=true on the server; a client-sent imported flag is ignored', async () => {
    await createOwnedBrand(OWN as never, { attributes: { ...BRAND_ATTRIBUTES, imported: true } });
    expect(mocks.brandCreate.mock.calls[0][2].attributes).not.toHaveProperty('imported');
    await createOwnedBrand(OWN as never, { attributes: BRAND_ATTRIBUTES, imported: true });
    expect(mocks.brandCreate.mock.calls[1][2].attributes).toMatchObject({ imported: true });
  });

  it('a pending name stores a null brand name', async () => {
    const { business_name: _n, ...rest } = BRAND_ATTRIBUTES;
    await createOwnedBrand(OWN as never, { attributes: { ...rest, name_pending: true } });
    expect(mocks.brandCreate.mock.calls[0][2]).toMatchObject({ name: null, attributes: { name_pending: true } });
  });

  it('createOwnedProduct: validates, then the limit refusal starts nothing; success returns the product conversation', async () => {
    expect(await createOwnedProduct(OWN as never, { brandId: BRAND as never, attributes: {} })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(mocks.productCreate).not.toHaveBeenCalled();
    mocks.productLimit.current = 5;
    expect(await createOwnedProduct(OWN as never, { brandId: BRAND as never, attributes: PRODUCT_ATTRIBUTES })).toEqual({
      ok: false, code: 'product_limit_reached', limit: 5, message: 'Esta marca llegó al límite de 5 productos. Pide a tu administrador que lo aumente.',
    });
    expect(mocks.startConversation).not.toHaveBeenCalled();
    mocks.productLimit.current = undefined;
    expect(await createOwnedProduct(OWN as never, { brandId: BRAND as never, attributes: PRODUCT_ATTRIBUTES })).toMatchObject({ ok: true, brandId: BRAND, productId: PRODUCT });
    expect(mocks.startConversation).toHaveBeenCalledTimes(1);
  });

  it('a conversation on a foreign brand starts nothing', async () => {
    expect(await createOwnedConversation(OWN as never, ids.missing as never)).toMatchObject({ ok: false, code: 'brand_not_found' });
    expect(mocks.startConversation).not.toHaveBeenCalled();
  });
});

describe('isConversationId', () => {
  it.each([
    [ids.latest, true],
    ['11111111-1111-4111-8111-11111111111', false],
    ['not-a-uuid', false],
    ['', false],
    [undefined, false],
    [42, false],
  ])('%j → %s', (value, expected) => {
    expect(isConversationId(value)).toBe(expected);
  });
});
