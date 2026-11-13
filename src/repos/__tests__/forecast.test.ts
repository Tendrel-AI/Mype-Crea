import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: async (_t: unknown, _u: unknown, work: (tx: { query: typeof mocked.query }) => unknown) => work({ query: mocked.query }),
}));

import { computeAndStore, forecastRepo } from '../forecast';
import { NotTenantAdminError } from '../tenant-accounts';

const MONTH = '2026-11-01';

/** Stand-in for Postgres: the SQL shape decides the answer; `stored` is the snapshot table. */
function fakeDb(opts: { isAdmin?: boolean; stored?: boolean }) {
  const stored: unknown[] = opts.stored ? [{ month: MONTH, inputs: { history: [], balanceUsd: 0 }, forecast: { expectedSpendUsd: 1 }, engine_version: 'old' }] : [];
  mocked.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('has_tenant_admin')) return { rows: [{ ok: opts.isAdmin ?? true }] };
    if (sql.includes("AS month") && sql.includes('date_trunc') && !sql.includes('FROM tenant_forecast_snapshots')) return { rows: [{ month: MONTH }] };
    if (sql.includes('forecast_history')) return { rows: [{ history: [] }] };
    if (sql.includes('FROM tenant_credit_entries')) return { rows: [{ balance: '3' }] };
    if (sql.includes('store_forecast_snapshot')) {
      stored.push({ month: params[1], inputs: JSON.parse(String(params[2])), forecast: JSON.parse(String(params[3])), engine_version: params[4] });
      return { rows: [] };
    }
    if (sql.includes('FROM tenant_forecast_snapshots')) return { rows: sql.includes('LIMIT 6') ? stored : stored.slice(0, 1) };
    throw new Error(`unexpected sql: ${sql}`);
  });
  return stored;
}

describe('forecast repo (D42)', () => {
  beforeEach(() => { mocked.query.mockReset(); });

  it('computes and stores the current-month snapshot when missing', async () => {
    const stored = fakeDb({});
    const view = await forecastRepo({ id: 't' }, { id: 'u' }).latest();
    expect(stored).toHaveLength(1);
    expect(view.current.month).toBe(MONTH);
    expect(view.current.inputs.balanceUsd).toBe(3);
    expect(view.current.forecast.pocosDatos).toBe(true);
  });

  it('serves the stored snapshot without recomputing', async () => {
    fakeDb({ stored: true });
    const view = await computeAndStore({ query: mocked.query }, 't');
    expect(view.current.engineVersion).toBe('old');
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('store_forecast_snapshot'))).toBe(false);
  });

  it('refuses a non-admin', async () => {
    fakeDb({ isAdmin: false });
    await expect(forecastRepo({ id: 't' }, { id: 'u' }).latest()).rejects.toBeInstanceOf(NotTenantAdminError);
  });
});
