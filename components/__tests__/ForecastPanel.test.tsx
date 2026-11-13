import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ForecastPanel from '../ForecastPanel';
import type { ForecastView } from '../../src/repos/forecast';

const snapshot = (pocosDatos: boolean) => ({
  month: '2026-11-01', engineVersion: 'forecast-1', inputs: { history: [], balanceUsd: 0 },
  forecast: { expectedSpendUsd: 12.5, perNewBrandUsd: 0.6, perNewProductUsd: 0.4, suggestedRechargeUsd: 15, confidence: pocosDatos ? 'low' : 'high', pocosDatos, weight: 0.1, settledCalls: 3 },
} as const);

describe('ForecastPanel (F22)', () => {
  it('shows spend, recharge, the badge and the month table', () => {
    const s = snapshot(true);
    const html = renderToStaticMarkup(<ForecastPanel view={{ current: s, recent: [s] } as ForecastView} />);
    expect(html).toContain('US$ 12.50');
    expect(html).toContain('US$ 15.00');
    expect(html).toContain('Pocos datos');
    expect(html).toContain('noviembre de 2026');
  });

  it('hides the badge with enough data', () => {
    const s = snapshot(false);
    const html = renderToStaticMarkup(<ForecastPanel view={{ current: s, recent: [s] } as ForecastView} />);
    expect(html).not.toContain('Pocos datos');
    expect(html).toContain('Alta');
  });
});
