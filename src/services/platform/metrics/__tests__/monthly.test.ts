import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonthlyPlatformMetric } from '../../../../repos/platform-metrics';

const monthly = vi.hoisted(() => vi.fn());
vi.mock('../../../../repos/platform-metrics', () => ({
  platformMetricsRepo: () => ({ monthly, recentAudit: vi.fn() }),
}));

import { MIN_COHORT_ACTIVE_USERS, getPlatformMonthlyMetrics } from '../monthly';

function row(organizationId: string | null, activeUsers: number): MonthlyPlatformMetric {
  return {
    month: '2026-10', organizationId, organizationName: organizationId ? `Org ${organizationId}` : 'Plataforma',
    activeUsers, newConversations: 7771, estimatedCost: 0.4321, errors: 913,
    providerModelUsage: [{ provider: 'anthropic', model: 'claude-haiku-5-5', calls: 6061, inputTokens: 55555, outputTokens: 44444, errors: 2, estimatedCost: 0.4321, costs: [{ currency: 'USD', source: 'estimated', amount: 0.4321 }] }],
    activeVersions: [{ moduleId: 'ai', version: 3 }],
  };
}

describe('getPlatformMonthlyMetrics small-cohort suppression (KAN-71)', () => {
  beforeEach(() => monthly.mockReset());

  it('uses k = 5', () => {
    expect(MIN_COHORT_ACTIVE_USERS).toBe(5);
  });

  it('a suppressed organization row exposes no counts or costs', async () => {
    monthly.mockResolvedValueOnce([row('small', 4), row('big', 5), row(null, 9)]);
    const [small, big, platform] = await getPlatformMonthlyMetrics('platform-admin', '2026-10');

    expect(small).toEqual({
      month: '2026-10', organizationId: 'small', organizationName: 'Org small', suppressed: true,
      activeUsers: null, newConversations: null, providerModelUsage: null, estimatedCost: null, errors: null,
      activeVersions: [{ moduleId: 'ai', version: 3 }],
    });
    const serialized = JSON.stringify(small);
    for (const leaked of ['7771', '0.4321', '913', '6061', '55555', '44444', 'claude-haiku', '"activeUsers":4']) {
      expect(serialized).not.toContain(leaked);
    }
    expect(big).toMatchObject({ suppressed: false, activeUsers: 5, newConversations: 7771, errors: 913 });
    expect(platform).toMatchObject({ organizationId: null, suppressed: false, activeUsers: 9 });
    expect(monthly).toHaveBeenCalledWith('2026-10', 'platform-admin');
  });

  it('suppresses the platform-wide totals when the platform has fewer than 5 active users', async () => {
    monthly.mockResolvedValueOnce([row(null, 4), row('zero', 0)]);
    const rows = await getPlatformMonthlyMetrics('platform-admin', '2026-10');
    for (const suppressed of rows) {
      expect(suppressed).toMatchObject({ suppressed: true, activeUsers: null, newConversations: null, providerModelUsage: null, estimatedCost: null, errors: null });
    }
  });
});
