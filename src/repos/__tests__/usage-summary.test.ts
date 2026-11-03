import { describe, expect, it } from 'vitest';
import { summarizeUsage } from '../usage-summary';

const budget = { committedUsd: 4.5, periodStart: '2026-11-01T05:00:00.000Z' };

function aggregate(overrides: Partial<Parameters<typeof summarizeUsage>[0]> = {}) {
  return {
    attempts: 2,
    inputTokens: 100,
    outputTokens: 40,
    unknownInputAttempts: 0,
    unknownOutputAttempts: 0,
    knownCost: '0.25',
    unknownCostAttempts: 0,
    ...overrides,
  };
}

describe('summarizeUsage', () => {
  it('reports complete cost accounting and the real monthly budget status (KAN-43)', () => {
    expect(summarizeUsage(aggregate(), budget)).toMatchObject({
      costAccountingStatus: 'complete',
      budgetStatus: { state: 'within_budget', limitUsd: 30, committedUsd: 4.5, remainingUsd: 25.5, periodStart: budget.periodStart },
      knownCost: 0.25,
    });
    expect(summarizeUsage(aggregate(), { ...budget, committedUsd: 30 }).budgetStatus).toMatchObject({ state: 'exhausted', remainingUsd: 0 });
    // Concurrent reservations can settle a little above the cap; remaining never goes negative.
    expect(summarizeUsage(aggregate(), { ...budget, committedUsd: 30.2 }).budgetStatus).toMatchObject({ state: 'exhausted', remainingUsd: 0 });
    expect(summarizeUsage(aggregate(), { ...budget, committedUsd: 29.7 }).budgetStatus.remainingUsd).toBe(0.3);
  });

  it('distinguishes partial and wholly unknown cost accounting', () => {
    expect(summarizeUsage(aggregate({ unknownCostAttempts: 1 }), budget)).toMatchObject({
      costAccountingStatus: 'partial',
      unknownCostAttempts: 1,
      knownCost: 0.25,
    });
    expect(summarizeUsage(aggregate({ unknownCostAttempts: 2 }), budget)).toMatchObject({
      costAccountingStatus: 'unknown',
      unknownCostAttempts: 2,
    });
  });

  it('reports no attempts and preserves unknown token counts instead of zeroing them', () => {
    expect(summarizeUsage(aggregate({ attempts: 0, inputTokens: null, outputTokens: null }), budget).costAccountingStatus)
      .toBe('no_attempts');
    expect(summarizeUsage(aggregate({ inputTokens: 10, unknownInputAttempts: 1 }), budget)).toMatchObject({
      inputTokens: null,
      unknownInputTokenAttempts: 1,
    });
  });
});
