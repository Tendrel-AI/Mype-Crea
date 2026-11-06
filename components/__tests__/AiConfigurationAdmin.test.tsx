import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../app/actions/ai-config', () => ({}));
vi.mock('../../app/actions/conversations', () => ({}));

import AiConfigurationAdmin from '../AiConfigurationAdmin';
import { summarizeUsage } from '../../src/repos/usage-summary';

function render(committedUsd: number): string {
  const usage = summarizeUsage(
    { attempts: 3, inputTokens: 10, outputTokens: 5, unknownInputAttempts: 0, unknownOutputAttempts: 0, knownCost: '0.01', unknownCostAttempts: 0 },
    { committedUsd, periodStart: '2026-11-01T05:00:00.000Z' },
  );
  return renderToStaticMarkup(<AiConfigurationAdmin initialData={{
    tenantId: 't', organizationId: 'o', tenantRole: 'admin', platformAdmin: false,
    releases: [], sharedReleases: [], activation: null, providers: [], providerStatus: [], syncEvents: [], turns: [], usage,
  }} />);
}

describe('AiConfigurationAdmin budget status (KAN-70)', () => {
  it('shows the recorded monthly spend, the USD 30 limit and what remains', () => {
    const html = render(12.4);
    expect(html).toContain('USD 12.40 gastados o reservados de USD 30.00; quedan USD 17.60');
    expect(html).not.toContain('agotado');
    expect(html).not.toMatch(/unconfigured|sin configurar|se define por separado/i);
    expect(html).not.toMatch(/\b(querés|tenés|podés|vos|sos)\b/i);
  });

  it('marks the budget as exhausted once recorded usage reaches the limit', () => {
    const html = render(30);
    expect(html).toContain('quedan USD 0.00');
    expect(html).toContain('agotado');
  });
});
