import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: vi.fn(async (_t: unknown, _u: unknown, cb: (tx: unknown) => unknown) => cb({ query: mocks.query })),
}));

import { usageRepo } from '../usage';

const tenant = { id: '11111111-1111-4111-8111-111111111111' };
const user = { id: '22222222-2222-4222-8222-222222222222' };

describe('usageRepo.decide active-user backstop (D52)', () => {
  beforeEach(() => mocks.query.mockReset());

  it('denies an inactive owner with user_inactive, records the denial and reads no counters', async () => {
    mocks.query.mockImplementation(async (sql = '') => {
      if (sql.includes('FROM users')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO usage_reservations')) return { rows: [{ id: 'res-1' }] };
      return { rows: [] };
    });
    const verdict = await usageRepo(tenant, user).reserve({ kind: 'llm', estimatedCostUsd: 0.01 });
    expect(verdict).toEqual({ allowed: false, reason: 'user_inactive', reservationId: 'res-1' });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('tenant_credit_entries'))).toBe(false);
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO usage_reservations'))!;
    expect(insert[1]).toEqual(expect.arrayContaining(['denied', 'user_inactive']));
  });

  it('lets an active owner through to the normal policy', async () => {
    mocks.query.mockImplementation(async (sql = '') => {
      if (sql.includes('FROM users')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('tenant_credit_entries')) return { rows: [{ balance: '10', reserved: '0', llm_hour: 0, image_day: 0 }] };
      return { rows: [] };
    });
    expect(await usageRepo(tenant, user).preflight({ kind: 'llm', estimatedCostUsd: 0.01 })).toEqual({ allowed: true, reservationId: null });
  });
});
