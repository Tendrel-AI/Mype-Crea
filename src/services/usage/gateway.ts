/**
 * KAN-43 usage gateway: the one wrapper every paid provider call runs through.
 *
 *   reserve (locked, estimated cost) → denied? throw UsageLimitError, provider never called
 *                                    → allowed? call the provider → settle with the real cost
 *
 * A failed call settles at `failureCostUsd(error)` (0 when the provider surely did not bill,
 * the estimate when the outcome is unknown). Each retry or fallback attempt is a separate call,
 * so it reserves and settles on its own. Hooked in at the two chokepoints: the LLM attempt
 * wrapper (`src/services/ai-config/execution.ts`) and `ImageGeneratorService.generate`.
 */
import type { UsageRepo, UsageRequest } from '../../repos/usage';
import { loggerFor } from '../logger';
import { usageLimitMessage, type ActualCost, type UsageDenialReason } from './policy';

const log = loggerFor('service.usage-gateway');

export type UsageLedger = Pick<UsageRepo, 'reserve' | 'settle'>;

export class UsageLimitError extends Error {
  readonly userMessage: string;
  constructor(readonly reason: UsageDenialReason, readonly reservationId: string | null = null) {
    super(`Usage limit reached: ${reason}.`);
    this.name = 'UsageLimitError';
    this.userMessage = usageLimitMessage(reason);
  }
}

export interface GatedCall<T> {
  readonly request: UsageRequest;
  readonly call: () => Promise<T>;
  /** Real cost of a successful call, with where it came from (provider-reported, estimate, flat price). */
  readonly actualCost: (result: T) => ActualCost;
  /** Cost to record when the call throws. */
  readonly failureCostUsd: (error: unknown) => number;
}

export async function runWithUsage<T>(ledger: UsageLedger, gated: GatedCall<T>): Promise<T> {
  const verdict = await ledger.reserve(gated.request);
  const child = log.child({ kind: gated.request.kind, reservationId: verdict.reservationId, ...correlation(gated.request) });
  if (!verdict.allowed) {
    child.warn({ reason: verdict.reason }, 'usage.denied');
    throw new UsageLimitError(verdict.reason, verdict.reservationId);
  }
  const reservationId = verdict.reservationId!;
  // A lost settlement leaves the row `reserved` at its estimate: conservative, never fatal.
  const settle = async (compute: () => ActualCost, outcome: 'succeeded' | 'failed') => {
    const { usd: actualCostUsd, source: costSource } = safeCost(compute, gated.request.estimatedCostUsd);
    try {
      await ledger.settle({ reservationId, actualCostUsd, costSource, outcome });
      child.debug({ actualCostUsd, costSource, outcome }, 'usage.settled');
    } catch (err) {
      child.error({ err, actualCostUsd, costSource, outcome }, 'usage.settle_failed');
    }
  };
  let result: T;
  try {
    result = await gated.call();
  } catch (error) {
    await settle(() => ({ usd: gated.failureCostUsd(error), source: 'estimate' }), 'failed');
    throw error;
  }
  await settle(() => gated.actualCost(result), 'succeeded');
  return result;
}

function safeCost(compute: () => ActualCost, fallback: number): ActualCost {
  try {
    const cost = compute();
    return Number.isFinite(cost.usd) && cost.usd >= 0 ? cost : { usd: fallback, source: 'estimate' };
  } catch {
    return { usd: fallback, source: 'estimate' };
  }
}

function correlation(request: UsageRequest) {
  return {
    provider: request.provider,
    model: request.model,
    conversationId: request.conversationId,
    turnId: request.turnId,
    attemptId: request.attemptId,
    agentTaskId: request.agentTaskId,
  };
}
