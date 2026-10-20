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
});
