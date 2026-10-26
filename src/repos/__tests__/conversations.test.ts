import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: async (_tenant: unknown, _user: unknown, work: (tx: { query: typeof mocked.query }) => unknown) => work({ query: mocked.query }),
  withTenantAdminTransaction: vi.fn(),
}));

import { RECENT_CONVERSATIONS_LIMIT, businessNameFromAgentStates, conversationsRepo } from '../conversations';

describe('conversationsRepo.ensurePinnedConversation', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  it('returns an existing immutable pin without resolving the current rollout', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT configuration_state, ai_release_id')) {
        return { rows: [{ configuration_state: 'pinned', ai_release_id: 'release-old' }] };
      }
      if (sql.includes('SELECT tenant_id, agent_states, started_at')) {
        return { rows: [{ tenant_id: 'tenant-a', agent_states: {}, started_at: new Date('2026-01-01T00:00:00.000Z') }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const pin = await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).ensurePinnedConversation({
      conversationId: 'conversation-a',
      schemas: [],
    });

    expect(pin).toMatchObject({ state: 'pinned', releaseId: 'release-old' });
    expect(mocked.query).toHaveBeenCalledTimes(2);
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('platform_module_assignments'))).toBe(false);
  });
  it('materializes a platform release only through the narrow helper, never by direct lock or insert', async () => {
    let created = false;
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT configuration_state, ai_release_id')) {
        return { rows: created ? [{ configuration_state: 'pinned', ai_release_id: 'release-platform' }] : [] };
      }
      if (sql.includes('FROM platform_module_assignments')) return { rows: [] };
      if (sql.includes('FROM ai_release_activations')) return { rows: [] };
      if (sql.includes('FROM platform_module_defaults')) return { rows: [{ shared_release_id: 'shared-default' }] };
      if (sql.includes('app.materialize_platform_ai_release')) return { rows: [{ id: 'release-platform' }] };
      if (sql.includes('INSERT INTO conversations')) { created = true; return { rows: [], rowCount: 1 }; }
      if (sql.includes('SELECT tenant_id, agent_states, started_at')) {
        return { rows: [{ tenant_id: 'tenant-a', agent_states: {}, started_at: new Date('2026-01-01T00:00:00.000Z') }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const pin = await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).ensurePinnedConversation({
      conversationId: 'conversation-a',
      schemas: [],
    });

    expect(pin).toMatchObject({ state: 'pinned', releaseId: 'release-platform' });
    const sqls = mocked.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.find((sql) => sql.includes('app.materialize_platform_ai_release'))).toBeDefined();
    expect(mocked.query.mock.calls.find(([sql]) => String(sql).includes('app.materialize_platform_ai_release'))?.[1])
      .toEqual(['shared-default']);
    expect(sqls.some((sql) => /FROM ai_shared_releases/i.test(sql))).toBe(false);
    expect(sqls.some((sql) => /INSERT INTO ai_releases/i.test(sql))).toBe(false);
  });
});

describe('conversationsRepo concurrent state mutations', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  it('locks the owner-visible conversation row before each read-modify-write', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT tenant_id, agent_states, started_at')) {
        return {
          rows: [{
            tenant_id: 'tenant-a',
            agent_states: {
              logo: {
                requiredFields: { business_name: { status: 'empty' } },
                optionalFields: {},
                iterationCount: 0,
              },
            },
            started_at: new Date('2026-01-01T00:00:00.000Z'),
          }],
        };
      }
      if (sql.includes('UPDATE conversations')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const repo = conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' });
    await repo.updateFieldSlot('conversation-a', 'logo', 'business_name', true, {
      status: 'filled', value: 'Tienda Sol', confidence: 1,
    }, []);

    const readSql = String(mocked.query.mock.calls[0][0]);
    expect(readSql).toMatch(/FROM conversations[\s\S]*LIMIT 1\s+FOR UPDATE/i);
    expect(mocked.query.mock.calls[1][0]).toContain('UPDATE conversations');
  });
});

describe('conversationsRepo.readPinnedConversation owner check (KAN-25)', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  it('filters by tenant and owner explicitly, on top of RLS', async () => {
    mocked.query.mockImplementation(async () => ({ rows: [] }));
    const pin = await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' })
      .readPinnedConversation('conversation-a', []);
    expect(pin).toBeUndefined();
    const [sql, params] = mocked.query.mock.calls[0];
    expect(String(sql)).toMatch(/WHERE id = \$1 AND tenant_id = \$2 AND user_id = \$3/);
    expect(params).toEqual(['conversation-a', 'tenant-a', 'user-a']);
    // Not visible → no snapshot read at all.
    expect(mocked.query).toHaveBeenCalledTimes(1);
  });
});

describe('conversationsRepo.listRecent (KAN-25)', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  const filledName = (value: string) => ({
    'logo-agent': {
      requiredFields: { business_name: { status: 'filled', value, confidence: 1 } },
      optionalFields: {},
      iterationCount: 0,
    },
  });

  it('lists only the caller’s pinned conversations by last activity, capped at 20', async () => {
    mocked.query.mockResolvedValue({ rows: [] });
    await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).listRecent();
    const [sql, params] = mocked.query.mock.calls[0];
    const text = String(sql);
    expect(text).toMatch(/c\.tenant_id = \$1\s+AND c\.user_id = \$2/);
    expect(text).toContain(`c.configuration_state = 'pinned'`);
    expect(text).toMatch(/COALESCE\(last_message\.created_at, c\.started_at\) AS last_activity_at/);
    expect(text).toMatch(/m\.tenant_id = c\.tenant_id AND m\.conversation_id = c\.id/);
    expect(text).toMatch(/ORDER BY last_activity_at DESC, c\.id DESC\s+LIMIT \$3/);
    expect(params).toEqual(['tenant-a', 'user-a', RECENT_CONVERSATIONS_LIMIT]);
    expect(RECENT_CONVERSATIONS_LIMIT).toBe(20);
  });

  it.each([[1, 1], [5, 5], [20, 20], [500, 20], [0, 1], [-3, 1]])('bounds limit %d to %d', async (asked, bound) => {
    mocked.query.mockResolvedValue({ rows: [] });
    await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).listRecent(asked);
    expect(mocked.query.mock.calls[0][1]).toEqual(['tenant-a', 'user-a', bound]);
  });

  it('maps rows in database order with ISO dates and the derived business name', async () => {
    mocked.query.mockResolvedValue({
      rows: [
        {
          id: 'conversation-new',
          started_at: new Date('2026-10-20T10:00:00.000Z'),
          last_activity_at: new Date('2026-10-24T15:00:00.000Z'),
          agent_states: filledName('Café Andino'),
        },
        {
          id: 'conversation-old',
          started_at: new Date('2026-10-01T10:00:00.000Z'),
          last_activity_at: new Date('2026-10-01T10:00:00.000Z'),
          agent_states: {},
        },
      ],
    });
    const rows = await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).listRecent();
    expect(rows).toEqual([
      {
        conversationId: 'conversation-new',
        startedAt: '2026-10-20T10:00:00.000Z',
        lastActivityAt: '2026-10-24T15:00:00.000Z',
        businessName: 'Café Andino',
      },
      {
        conversationId: 'conversation-old',
        startedAt: '2026-10-01T10:00:00.000Z',
        lastActivityAt: '2026-10-01T10:00:00.000Z',
        businessName: null,
      },
    ]);
  });
});

describe('businessNameFromAgentStates (KAN-25)', () => {
  it('returns the first filled, non-blank business_name, trimmed', () => {
    expect(businessNameFromAgentStates({
      'logo-agent': { requiredFields: { business_name: { status: 'filled', value: '  Café Andino ', confidence: 1 } }, optionalFields: {} },
    })).toBe('Café Andino');
    expect(businessNameFromAgentStates({
      'a': { requiredFields: { business_name: { status: 'empty' } }, optionalFields: {} },
      'b': { requiredFields: {}, optionalFields: { business_name: { status: 'filled', value: 'Tienda Sol', confidence: 1 } } },
    })).toBe('Tienda Sol');
  });

  it.each([
    ['no states', {}],
    ['null', null],
    ['not an object', 'texto'],
    ['empty slot', { a: { requiredFields: { business_name: { status: 'empty' } } } }],
    ['unconfirmed value', { a: { requiredFields: { business_name: { status: 'pending_confirmation', value: 'Quizá', confidence: 0.5 } } } }],
    ['blank value', { a: { requiredFields: { business_name: { status: 'filled', value: '   ', confidence: 1 } } } }],
    ['non-string value', { a: { requiredFields: { business_name: { status: 'filled', value: 42, confidence: 1 } } } }],
  ])('returns null for %s', (_label, states) => {
    expect(businessNameFromAgentStates(states)).toBeNull();
  });
});
