import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../../db/global-transaction', () => ({
  withGlobalTransaction: async (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query }),
}));

import { platformMetricsRepo } from '../platform-metrics';

describe('platform metrics repository', () => {
  beforeEach(() => query.mockReset());

  it('uses the monthly aggregate function and maps both platform and organization rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ authorized: true }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [
      { period_start: '2026-10-01', organization_id: null, organization_name: null, active_users: '1', new_conversations: '2', provider_model_usage: [], estimated_cost: '0.25', errors: '1', active_versions: [] },
      { period_start: '2026-10-01', organization_id: 'org-1', organization_name: 'Negocio', active_users: '1', new_conversations: '2', provider_model_usage: [], estimated_cost: '0.25', errors: '1', active_versions: [] },
    ] });
    const rows = await platformMetricsRepo().monthly('2026-10', 'platform-admin');
    expect(query.mock.calls[2][0]).toContain('app.platform_monthly_metrics($1::date)');
    expect(query.mock.calls[2][0]).not.toMatch(/\busers\b|\bmessages\b/);
    expect(rows.map((row) => [row.organizationId, row.activeUsers])).toEqual([[null, 1], ['org-1', 1]]);
    expect(rows[0].month).toBe('2026-10');
  });

  it('rejects non-calendar month input before querying', async () => {
    await expect(platformMetricsRepo().monthly('2026-Q4', 'platform-admin')).rejects.toThrow('YYYY-MM');
    expect(query).not.toHaveBeenCalled();
  });
});
