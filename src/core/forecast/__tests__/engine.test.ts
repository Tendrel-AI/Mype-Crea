import { describe, expect, it } from 'vitest';
import { forecast, SHRINKAGE_K, type MonthHistory } from '../engine';
import { FORECAST_SEED } from '../seed';

const month = (over: Partial<MonthHistory>): MonthHistory => ({
  month: '2026-10-01', brands: 1, products: 1, deliverables: {}, alterations: 0, turns: 0,
  costUsd: { llm: 1, image: 1 }, settledCalls: 0, rechargedUsd: 0, ...over,
});

describe('forecast engine (D42)', () => {
  it('no history: seed values, weight 0, low confidence with «pocos datos»', () => {
    const r = forecast({ history: [], balanceUsd: 0 });
    const d = FORECAST_SEED.defaultMonth;
    const expected = 12 * 0.0 + 4 * 0.08 + 4 * 0.01 + 4 * 0.01
      + d.alterations * FORECAST_SEED.costPerAlterationUsd + d.turns * FORECAST_SEED.costPerTurnUsd;
    expect(r.expectedSpendUsd).toBeCloseTo(expected, 6);
    expect(r.perNewBrandUsd).toBe(FORECAST_SEED.costPerBrandUsd);
    expect(r.weight).toBe(0);
    expect(r).toMatchObject({ confidence: 'low', pocosDatos: true });
  });

  it('much history: converges to the tenant mean', () => {
    const r = forecast({ history: [month({ settledCalls: 100000, costUsd: { llm: 30, image: 10 } })], balanceUsd: 0 });
    expect(r.expectedSpendUsd).toBeCloseTo(40, 1);
    expect(r.weight).toBeGreaterThan(0.999);
    expect(r).toMatchObject({ confidence: 'high', pocosDatos: false });
  });

  it('mid history: between seed and tenant, weight n/(n+k)', () => {
    const r = forecast({ history: [month({ settledCalls: SHRINKAGE_K, costUsd: { llm: 30, image: 10 } })], balanceUsd: 0 });
    expect(r.weight).toBe(0.5);
    expect(r.expectedSpendUsd).toBeCloseTo(20, 5); // seed spend of an empty month is 0, tenant is 40
    expect(r.confidence).toBe('medium');
  });

  it('suggested recharge: shortfall rounded up to the step, never negative', () => {
    const history = [month({ settledCalls: 100000, costUsd: { llm: 12, image: 0 } })];
    expect(forecast({ history, balanceUsd: 4 }).suggestedRechargeUsd).toBe(10); // 8 -> 10
    expect(forecast({ history, balanceUsd: 2 }).suggestedRechargeUsd).toBe(10); // exactly 10 stays 10
    expect(forecast({ history, balanceUsd: 50 }).suggestedRechargeUsd).toBe(0);
  });
});
