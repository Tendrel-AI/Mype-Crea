import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../app/actions/ai-config', () => ({}));
vi.mock('../../app/actions/conversations', () => ({}));

import AiConfigurationAdmin from '../AiConfigurationAdmin';
import { summarizeUsage } from '../../src/repos/usage-summary';

function render(balanceUsd: number): string {
  const usage = summarizeUsage(
    { attempts: 3, inputTokens: 10, outputTokens: 5, unknownInputAttempts: 0, unknownOutputAttempts: 0, knownCost: '0.01', unknownCostAttempts: 0 },
    { balanceUsd, reservedUsd: 0.5 },
  );
  return renderToStaticMarkup(<AiConfigurationAdmin initialData={{
    tenantId: 't', organizationId: 'o', tenantRole: 'admin', platformAdmin: false,
    releases: [], sharedReleases: [], activation: null, providers: [], providerStatus: [], syncEvents: [], turns: [], usage,
  }} />);
}

describe('AiConfigurationAdmin budget status (KAN-70)', () => {
  it('shows the credit balance, what is held and what is available', () => {
    const html = render(12.5);
    expect(html).toContain('USD 12.50 de saldo, USD 0.50 reservados; disponibles USD 12.00');
    expect(html).not.toContain('agotado');
    expect(html).not.toMatch(/unconfigured|sin configurar|se define por separado/i);
    expect(html).not.toMatch(/\b(querés|tenés|podés|vos|sos)\b/i);
  });

  it('marks the credits as exhausted once nothing is available', () => {
    const html = render(0.5);
    expect(html).toContain('disponibles USD 0.00');
    expect(html).toContain('agotado');
  });
});
