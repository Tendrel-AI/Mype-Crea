import type { UsageSummary } from './models';
import { USAGE_POLICY } from '../services/usage/policy';

export interface UsageAggregate {
  readonly attempts: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly unknownInputAttempts: number;
  readonly unknownOutputAttempts: number;
  readonly knownCost: string;
  readonly unknownCostAttempts: number;
}

/** Preserve unknown accounting separately from any known subtotal. */
export function summarizeUsage(
  aggregate: UsageAggregate,
  budget: { readonly committedUsd: number; readonly periodStart: string },
): UsageSummary {
  const { attempts, unknownCostAttempts } = aggregate;
  const costAccountingStatus = attempts === 0
    ? 'no_attempts'
    : unknownCostAttempts >= attempts
      ? 'unknown'
      : unknownCostAttempts > 0
        ? 'partial'
        : 'complete';

  return {
    attempts,
    inputTokens: aggregate.unknownInputAttempts > 0 ? null : aggregate.inputTokens,
    outputTokens: aggregate.unknownOutputAttempts > 0 ? null : aggregate.outputTokens,
    unknownInputTokenAttempts: aggregate.unknownInputAttempts,
    unknownOutputTokenAttempts: aggregate.unknownOutputAttempts,
    knownCost: Number(aggregate.knownCost),
    unknownCostAttempts,
    costAccountingStatus,
    budgetStatus: {
      state: budget.committedUsd >= USAGE_POLICY.tenantMonthlyBudgetUsd ? 'exhausted' : 'within_budget',
      limitUsd: USAGE_POLICY.tenantMonthlyBudgetUsd,
      committedUsd: budget.committedUsd,
      periodStart: budget.periodStart,
    },
  };
}
