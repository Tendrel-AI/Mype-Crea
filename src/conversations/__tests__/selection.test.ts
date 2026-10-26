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
  listTurns: vi.fn(),
  listNotices: vi.fn(),
  listByConversation: vi.fn(),
  startConversation: vi.fn(async () => undefined),
  resolveIdentity: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => '77777777-7777-4777-8777-777777777777',
}));
vi.mock('../../auth/resolve-identity', () => ({ resolveIdentity: mocks.resolveIdentity }));
vi.mock('../../core/orchestrator/runtime', () => ({
  getOrchestrator: () => ({ startConversation: mocks.startConversation }),
}));
vi.mock('../../core/orchestrator/bootstrap-registry', () => ({
  buildDefaultRegistry: () => ({ getFieldSchemas: () => [] }),
}));
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
            conversationId: row.id, startedAt: row.lastActivityAt, lastActivityAt: row.lastActivityAt, businessName: row.businessName,
          }))),
        readPinnedConversation: async (conversationId: string) => {
          await mocks.readPinnedConversation(tenant, user, conversationId);
          const row = mocks.store.find((candidate) => candidate.id === conversationId && visible(candidate));
          return row
            ? { conversationId, state: row.state, releaseId: row.state === 'pinned' ? 'release-1' : null, snapshot: {} }
            : undefined;
        },
        ensurePinnedConversation: async (input: { conversationId: string }) => {
          await mocks.ensurePinnedConversation(tenant, user, input);
          mocks.store.push({
            id: input.conversationId, tenantId: tenant.id, userId: user.id, state: 'pinned',
            lastActivityAt: '2026-10-25T12:00:00.000Z', businessName: null,
          });
          return { conversationId: input.conversationId, state: 'pinned', releaseId: 'release-1', snapshot: {} };
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
  createOwnedConversation,
  isConversationId,
  listOwnedConversations,
  resolveHomeConversation,
} from '../selection';

function seed(): StoredConversation[] {
  return [
    { id: ids.older, tenantId: 'tenant-a', userId: 'user-a', state: 'pinned', lastActivityAt: '2026-10-20T15:00:00.000Z', businessName: null },
    { id: ids.latest, tenantId: 'tenant-a', userId: 'user-a', state: 'pinned', lastActivityAt: '2026-10-24T15:00:00.000Z', businessName: 'Café Andino' },
    // Newest of all, but legacy: never listed, never resumed.
    { id: ids.legacy, tenantId: 'tenant-a', userId: 'user-a', state: 'legacy_unversioned', lastActivityAt: '2026-10-25T09:00:00.000Z', businessName: 'Antigua' },
    // Same tenant, another member.
    { id: ids.otherUser, tenantId: 'tenant-a', userId: 'user-b', state: 'pinned', lastActivityAt: '2026-10-25T10:00:00.000Z', businessName: 'Ajena' },
    // Another tenant (same user id on purpose: the tenant axis alone must hide it).
    { id: ids.otherTenant, tenantId: 'tenant-b', userId: 'user-a', state: 'pinned', lastActivityAt: '2026-10-25T11:00:00.000Z', businessName: 'Otra empresa' },
  ];
}

const OWN_LIST = [
  { conversationId: ids.latest, label: 'Café Andino · 24 oct', lastActivityAt: '2026-10-24T15:00:00.000Z' },
  { conversationId: ids.older, label: 'Nueva conversación · 20 oct', lastActivityAt: '2026-10-20T15:00:00.000Z' },
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
    expect(result).toEqual({ kind: 'redirect', conversationId: ids.latest, created: false });
    expect(mocks.listRecent).toHaveBeenCalledWith(OWN.tenant, OWN.user, 1);
    expect(mocks.ensurePinnedConversation).not.toHaveBeenCalled();
    expect(mocks.startConversation).not.toHaveBeenCalled();
  });

  it('without an id and with no resumable conversation (only legacy or foreign rows), creates one', async () => {
    mocks.store = seed().filter((row) => row.id !== ids.latest && row.id !== ids.older);
    const result = await resolveHomeConversation(undefined);
    expect(result).toEqual({ kind: 'redirect', conversationId: ids.created, created: true });
    expect(mocks.ensurePinnedConversation).toHaveBeenCalledWith(OWN.tenant, OWN.user, expect.objectContaining({ conversationId: ids.created }));
    expect(mocks.startConversation).toHaveBeenCalledWith(ids.created, 'tenant-a', 'user-a');
  });

  it('opens an own conversation with its history, deliverables and the own list', async () => {
    const result = await resolveHomeConversation(ids.older);
    expect(result).toMatchObject({
      kind: 'open',
      history: {
        conversationId: ids.older,
        turns: [{ requestId: 'request-1', userMessage: 'Quiero un logo', content: '¡Vamos!', stage: 'responded' }],
        deliverables: [{ id: 'deliverable-1', kind: 'logo', contentUrl: 'https://assets.example/logo.png' }],
      },
      conversations: OWN_LIST,
    });
    expect(mocks.listTurns).toHaveBeenCalledWith(ids.older);
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
    const expected = { kind: 'not_found', message: CONVERSATION_NOT_FOUND_MESSAGE, conversations: OWN_LIST };
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
    const created = await createOwnedConversation(OWN as never);
    expect(created).toEqual({ ok: true, conversationId: ids.created });
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

  it('reports a safe error when a new conversation cannot be pinned', async () => {
    mocks.store = [];
    mocks.ensurePinnedConversation.mockImplementationOnce(async () => { throw new Error('no release'); });
    const result = await resolveHomeConversation(undefined);
    expect(result).toEqual({ kind: 'error', message: 'No pudimos iniciar la conversación. Inténtalo de nuevo.' });
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
