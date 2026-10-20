import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
  if (typeof sql === 'string' && sql.includes('platform_superadmins')) return { rows: [{ ok: 1 }], rowCount: 1 };
  if (typeof sql === 'string' && sql.includes('FROM users')) return { rows: [{ ok: 1 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});

vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: vi.fn(async (_tenant: unknown, _user: unknown, callback: (tx: unknown) => unknown) =>
    callback({ query })),
}));

describe('AI shared configuration platform context', () => {
  beforeEach(() => query.mockClear());

  it('binds the persisted platform actor for shared release RLS after validating the role', async () => {
    const { aiConfigRepo } = await import('../ai-config');
    const actorId = 'user_testplatformactor123';
    const repo = aiConfigRepo(
      { id: 'tenant-id' } as never,
      { id: 'tenant-user-id' } as never,
      { workosUserId: actorId, platformAdmin: true, tenantRole: 'member' },
    );

    await repo.listSharedReleases();

    const sql = query.mock.calls.map(([statement]) => statement);
    const roleCheck = sql.findIndex((statement) => String(statement).includes('platform_superadmins'));
    const actorBinding = sql.findIndex((statement) => String(statement).includes("app.platform_actor_workos_user_id"));
    expect(roleCheck).toBeGreaterThanOrEqual(0);
    expect(actorBinding).toBeGreaterThan(roleCheck);
    expect(query.mock.calls[actorBinding]?.[1]).toEqual([actorId]);
  });
});
