import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: async (_tenant: unknown, _user: unknown, work: (tx: { query: typeof mocked.query }) => unknown) => work({ query: mocked.query }),
  withTenantAdminTransaction: vi.fn(),
}));

import { conversationsRepo } from '../conversations';

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
