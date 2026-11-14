import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/global-transaction', () => ({
  withGlobalTransaction: async (work: (tx: { query: typeof mocked.query }) => unknown) => work({ query: mocked.query }),
}));

import { globalLimitsRepo } from '../global-limits';
import { globalCountersRepo } from '../global-counters';

beforeEach(() => {
  mocked.query.mockReset();
  mocked.query.mockImplementation(async (sql: string) => {
    if (sql.includes('platform_superadmins')) return { rows: [{ authorized: true }] };
    if (sql.includes('set_platform_limit_default')) return { rows: [{ before: 3 }] };
    if (sql.includes('platform_tenant_counters')) return { rows: [{ c: { brands: 2, deliverablesByKind: [] } }] };
    if (sql.includes('tenant_credit_entries')) return { rows: [{ balance: '10', consumed: '2.5' }] };
    return { rows: [] };
  });
});

describe('globalLimitsRepo.set', () => {
  it('asserts the actor, writes through the SQL function and audits before/after', async () => {
    await globalLimitsRepo().set({ limitKey: 'brands.per_user', value: 4, reason: 'why', actorWorkosUserId: 'user_A' });
    const sqls = mocked.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.findIndex((s) => s.includes('platform_superadmins'))).toBeLessThan(sqls.findIndex((s) => s.includes('set_platform_limit_default')));
    const audit = mocked.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO platform_audit_events'))!;
    expect(audit[1]).toContain('limits.default.set');
    expect(JSON.parse(audit[1][8])).toEqual({ before: 3, after: 4 });
  });

  it('does not audit when the actor is not an active superadmin', async () => {
    mocked.query.mockImplementation(async () => ({ rows: [{ authorized: false }] }));
    await expect(globalLimitsRepo().set({ limitKey: 'brands.per_user', value: 4, reason: 'why', actorWorkosUserId: 'x' })).rejects.toThrow();
    expect(mocked.query.mock.calls.some((c) => String(c[0]).includes('platform_audit_events'))).toBe(false);
  });
});

describe('globalCountersRepo.forTenant', () => {
  it('merges the SQL aggregates with balance and 30-day consumption', async () => {
    const result = await globalCountersRepo().forTenant('user_A', 'tenant-1');
    expect(result).toMatchObject({ brands: 2, balanceUsd: 10, consumption30dUsd: 2.5 });
  });
});
