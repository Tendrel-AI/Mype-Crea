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
  beforeEach(() => {
    query.mockClear();
    query.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('platform_superadmins')) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (typeof sql === 'string' && sql.includes('FROM users')) return { rows: [{ ok: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });

  it('enables role lookup RLS, verifies persisted role and local identity, then binds the actor', async () => {
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
    const adminContext = sql.findIndex((statement) => String(statement).includes("app.is_platform_admin"));
    const localIdentityCheck = sql.findIndex((statement) => String(statement).includes('FROM users'));
    const actorBinding = sql.findIndex((statement) => String(statement).includes("app.platform_actor_workos_user_id"));
    expect(roleCheck).toBeGreaterThanOrEqual(0);
    expect(adminContext).toBeGreaterThanOrEqual(0);
    expect(adminContext).toBeLessThan(roleCheck);
    expect(localIdentityCheck).toBeGreaterThan(roleCheck);
    expect(actorBinding).toBeGreaterThan(localIdentityCheck);
    expect(query.mock.calls[actorBinding]?.[1]).toEqual([actorId]);
  });

  it('does not grant shared write context when the persisted role is absent', async () => {
    query.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('platform_superadmins')) return { rows: [], rowCount: 0 };
      return { rows: [{ ok: 1 }], rowCount: 1 };
    });
    const { aiConfigRepo } = await import('../ai-config');
    const repo = aiConfigRepo(
      { id: 'tenant-id' } as never,
      { id: 'tenant-user-id' } as never,
      { workosUserId: 'user_testplatformactor123', platformAdmin: true },
    );

    await expect(repo.createSharedDraft({ name: 'Shared', manifest: {} as never, allowedOverridePaths: [] })).rejects.toThrow();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('app.platform_actor_workos_user_id'))).toBe(false);
  });

  it('does not query or bind platform context from the actor flag alone', async () => {
    const { aiConfigRepo } = await import('../ai-config');
    const repo = aiConfigRepo(
      { id: 'tenant-id' } as never,
      { id: 'tenant-user-id' } as never,
      { workosUserId: 'user_testplatformactor123', platformAdmin: false },
    );

    await expect(repo.createSharedDraft({ name: 'Shared', manifest: {} as never, allowedOverridePaths: [] })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
