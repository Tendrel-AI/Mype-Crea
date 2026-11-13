import { describe, expect, it } from 'vitest';
import { summarizeUsage } from '../usage-summary';

const budget = { balanceUsd: 30, reservedUsd: 4.5 };

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
  it('reports complete cost accounting and the credit status (D36)', () => {
    expect(summarizeUsage(aggregate(), budget)).toMatchObject({
      costAccountingStatus: 'complete',
      budgetStatus: { state: 'within_budget', balanceUsd: 30, reservedUsd: 4.5, availableUsd: 25.5 },
      knownCost: 0.25,
    });
    expect(summarizeUsage(aggregate(), { balanceUsd: 4.5, reservedUsd: 4.5 }).budgetStatus).toMatchObject({ state: 'exhausted', availableUsd: 0 });
    // A settlement above the estimate can leave a negative balance: still exhausted, shown as is.
    expect(summarizeUsage(aggregate(), { balanceUsd: -0.2, reservedUsd: 0 }).budgetStatus).toMatchObject({ state: 'exhausted', availableUsd: -0.2 });
    expect(summarizeUsage(aggregate(), { balanceUsd: 30, reservedUsd: 29.7 }).budgetStatus.availableUsd).toBe(0.3);
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
