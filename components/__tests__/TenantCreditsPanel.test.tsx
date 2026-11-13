import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TenantCreditsPanel from '../TenantCreditsPanel';
import AdminNav from '../AdminNav';
import { USAGE_POLICY } from '../../src/services/usage/policy';
import type { TenantCreditSummary } from '../../src/repos/credits';

const base: TenantCreditSummary = {
  balanceUsd: 42.5, grantedUsd: 100, consumptionByKind: { llm: 50, image: 7.5 }, consumptionByMonth: { current: 12.5, previous: 3 },
};

describe('TenantCreditsPanel (F21)', () => {
  it('shows USD amounts with 2 decimals and no recharge note on a healthy balance', () => {
    const html = renderToStaticMarkup(<TenantCreditsPanel summary={base} />);
    for (const t of ['US$ 42.50', 'US$ 100.00', 'US$ 50.00', 'US$ 7.50', 'US$ 12.50', 'US$ 3.00']) expect(html).toContain(t);
    expect(html).not.toContain('Pide una recarga');
  });

  it('shows the recharge note at the low threshold', () => {
    const html = renderToStaticMarkup(<TenantCreditsPanel summary={{ ...base, balanceUsd: USAGE_POLICY.lowBalanceUsd }} />);
    expect(html).toContain('Pide una recarga al administrador de la plataforma');
  });
});

describe('AdminNav', () => {
  it('lists the six admin links', () => {
    const html = renderToStaticMarkup(<AdminNav />);
    for (const h of ['accounts', 'limits', 'credits', 'analytics', 'forecast', 'ai']) expect(html).toContain(`href="/admin/${h}"`);
  });
});
