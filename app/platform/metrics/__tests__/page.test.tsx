import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const monthly = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/auth/resolve-identity', () => ({ requireGlobalMfa: async () => ({ workosUserId: 'platform-admin' }) }));
vi.mock('../../../../src/repos/platform-metrics', () => ({ platformMetricsRepo: () => ({ monthly, recentAudit: vi.fn() }) }));

import PlatformMetricsPage from '../page';

describe('/platform/metrics page (KAN-71)', () => {
  it('shows «Datos insuficientes» instead of the counts of a small organization', async () => {
    const base = { month: '2026-10', providerModelUsage: [], estimatedCost: 0.9876, errors: 913, activeVersions: [] };
    monthly.mockResolvedValueOnce([
      { ...base, organizationId: null, organizationName: 'Plataforma', activeUsers: 6, newConversations: 40 },
      { ...base, organizationId: 'small', organizationName: 'Bodega Chica', activeUsers: 3, newConversations: 7771 },
    ]);
    const html = renderToStaticMarkup(await PlatformMetricsPage({ searchParams: Promise.resolve({ month: '2026-10' }) }));
    expect(html).toContain('Bodega Chica');
    expect(html).toContain('Datos insuficientes para mostrar');
    expect(html).not.toContain('7,771');
    expect(html).not.toContain('7771');
    expect(html).toContain('40');
  });
});
