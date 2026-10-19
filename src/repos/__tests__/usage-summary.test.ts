import { describe, expect, it } from 'vitest';
import { summarizeUsage } from '../usage-summary';

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
  it('reports complete cost accounting and an unconfigured budget explicitly', () => {
    expect(summarizeUsage(aggregate())).toMatchObject({
      costAccountingStatus: 'complete',
      budgetStatus: 'unconfigured',
      knownCost: 0.25,
    });
  });

  it('distinguishes partial and wholly unknown cost accounting', () => {
    expect(summarizeUsage(aggregate({ unknownCostAttempts: 1 }))).toMatchObject({
      costAccountingStatus: 'partial',
      unknownCostAttempts: 1,
      knownCost: 0.25,
    });
    expect(summarizeUsage(aggregate({ unknownCostAttempts: 2 }))).toMatchObject({
      costAccountingStatus: 'unknown',
      unknownCostAttempts: 2,
    });
  });

  it('reports no attempts and preserves unknown token counts instead of zeroing them', () => {
    expect(summarizeUsage(aggregate({ attempts: 0, inputTokens: null, outputTokens: null })).costAccountingStatus)
      .toBe('no_attempts');
    expect(summarizeUsage(aggregate({ inputTokens: 10, unknownInputAttempts: 1 }))).toMatchObject({
      inputTokens: null,
      unknownInputTokenAttempts: 1,
    });
  });
});
