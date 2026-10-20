import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn(async (sql: string) => {
  if (typeof sql === 'string' && sql.includes('SELECT EXISTS')) return { rows: [{ authorized: true }], rowCount: 1 };
  if (typeof sql === 'string' && sql.includes('SELECT max(version)')) return { rows: [{ version: null }], rowCount: 1 };
  if (typeof sql === 'string' && sql.includes('INSERT INTO platform_module_versions')) return { rows: [{
    module_id: 'brand', version: 1, config: { enabled: true }, created_by_workos_user_id: 'user_platform',
    created_at: '2026-10-19T00:00:00.000Z', previous_version: null,
  }], rowCount: 1 };
  return { rows: [], rowCount: 1 };
});

vi.mock('../../db/global-transaction', () => ({
  withGlobalTransaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ query })),
}));

describe('platform module version persistence', () => {
  beforeEach(() => query.mockClear());

  it('locks a module version sequence before reading its latest version', async () => {
    const { platformConfigRepo } = await import('../platform-config');
    const repo = platformConfigRepo();

    const result = await repo.createVersion({
      moduleId: 'brand',
      config: { enabled: true },
      actorWorkosUserId: 'user_platform',
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const lockIndex = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const latestIndex = statements.findIndex((sql) => sql.includes('SELECT max(version)'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(latestIndex).toBeGreaterThan(lockIndex);
    expect(result.version).toBe(1);
  });
});
