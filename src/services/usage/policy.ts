/**
 * KAN-43 usage policy: THE place for the approved limits, the cost estimates and the
 * client-facing denial copy. Pure (no I/O). Owner-approved values (2026-11-02); the policy
 * record is pipeline/decisions/KAN-43-usage-limits-policy.md. Change a limit here, nowhere else.
 * D36: the tenant cap is its prepaid credit balance (ledger), not a fixed monthly amount.
 */
import { codePointLength } from '../../core/refinement';

export const USAGE_POLICY = Object.freeze({
  /** LLM calls per user in a rolling 60-minute window. */
  userLlmCallsPerHour: 60,
  /** Image generations per user per calendar day (America/Lima). */
  userImagesPerDay: 15,
  /** Characters (Unicode code points) per user chat message. */
  maxInputChars: 4000,
  /** At or below this balance (USD) the tenant admin is told to ask for a recharge (F21). */
  lowBalanceUsd: 5,
  /** Calendar month/day boundaries are taken in this zone (pilot users are in Peru). */
  timeZone: 'America/Lima',
});

export type UsagePolicy = typeof USAGE_POLICY;
export type UsageKind = 'llm' | 'image';
export type UsageDenialReason = 'tenant_credits' | 'user_llm_hourly' | 'user_image_daily' | 'input_too_long' | 'user_inactive';

/** What the ledger has already committed, read under the tenant lock. */
export interface UsageCounters {
  /** Credit ledger sum of the tenant (recharges - consumption +/- adjustments), USD. */
  readonly balanceUsd: number;
  /** Estimates held by `reserved` rows (calls in flight), all users of the tenant. */
  readonly reservedUsd: number;
  readonly userLlmCallsLastHour: number;
  readonly userImagesToday: number;
}

export interface UsageAsk {
  readonly kind: UsageKind;
  readonly estimatedCostUsd: number;
  /** Provider calls this request needs (a chat turn preflight asks for 2). */
  readonly calls?: number;
  readonly inputChars?: number;
}

/** Null when allowed; otherwise the first limit the request would break. */
export function evaluateUsage(
  counters: UsageCounters,
  ask: UsageAsk,
  policy: UsagePolicy = USAGE_POLICY,
): UsageDenialReason | null {
  const calls = ask.calls ?? 1;
  if (ask.inputChars !== undefined && ask.inputChars > policy.maxInputChars) return 'input_too_long';
  const available = availableCreditsUsd(counters);
  if (available <= 0 || ask.estimatedCostUsd > available) return 'tenant_credits';
  if (ask.kind === 'llm' && counters.userLlmCallsLastHour + calls > policy.userLlmCallsPerHour) return 'user_llm_hourly';
  if (ask.kind === 'image' && counters.userImagesToday + calls > policy.userImagesPerDay) return 'user_image_daily';
  return null;
}

/** Credits the tenant can still commit: balance minus what in-flight calls hold. Ledger precision. */
export function availableCreditsUsd(counters: Pick<UsageCounters, 'balanceUsd' | 'reservedUsd'>): number {
  return roundUsd(counters.balanceUsd - counters.reservedUsd);
}

export function inputChars(text: string): number {
  return codePointLength(text);
}

/** Neutral Latin-American Spanish, tuteo. Shown to the user when a call is denied. */
export function usageLimitMessage(reason: UsageDenialReason): string {
  switch (reason) {
    case 'tenant_credits':
      return 'Tu organización debe recargar créditos. Avísale al administrador de tu organización.';
    case 'user_llm_hourly':
      return 'Alcanzaste el límite de mensajes por hora. Espera un momento e inténtalo de nuevo.';
    case 'user_image_daily':
      return 'Alcanzaste el límite de imágenes de hoy. Podrás generar más mañana.';
    case 'user_inactive':
      return 'Tu cuenta está desactivada. Contacta al administrador de tu organización.';
    case 'input_too_long':
      return `Tu mensaje es demasiado largo. Escribe hasta ${USAGE_POLICY.maxInputChars} caracteres.`;
  }
}

// ---------------------------------------------------------------------------
// Prices. Estimates (pre-call hold) and the fallback when a provider reports no cost: list prices
// typed in by hand on 2026-11-03. OpenRouter's own `usage.cost` wins whenever it is present (D36).
// Unknown models use the conservative default so an unpriced model can't look cheap.
// ---------------------------------------------------------------------------

export const PRICING_VERSION = 'kan-43.2026-11-14';

interface TokenPrice { readonly inputPerMTok: number; readonly outputPerMTok: number }

const LLM_PRICES: Readonly<Record<string, TokenPrice>> = {
  'google/gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'google/gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
  // shortcut: Haiku 5.5's rate for prompts up to 100k tokens (5x above); ours stay far below, add the tier if that changes.
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  'anthropic/claude-sonnet-5.5': { inputPerMTok: 2, outputPerMTok: 10 },
  'anthropic/claude-haiku-5.5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
};
const DEFAULT_LLM_PRICE: TokenPrice = { inputPerMTok: 5, outputPerMTok: 25 };
/** One fal FLUX.3 Klein 1K image (text-to-image or edit, per output image): USD 0.009 (fal schedule, 2026-11-14). */
export const IMAGE_PRICE_USD = 0.009;
/** Output tokens assumed when a request sets no max_tokens. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function priceFor(model: string): TokenPrice {
  return LLM_PRICES[model] ?? DEFAULT_LLM_PRICE;
}

/** Upper-bound estimate before the call: ~3 chars per input token, the full output allowance. */
export function estimateLlmCostUsd(request: {
  readonly model: string;
  readonly messages?: unknown;
  readonly tools?: unknown;
  readonly max_tokens?: number;
}): number {
  const price = priceFor(request.model);
  const inputTokens = Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 3);
  const outputTokens = request.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return roundUsd((inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000);
}

/** Cost of a finished call from the provider-reported token usage; null when usage is missing. */
export function llmCostUsd(
  model: string,
  usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cached_tokens?: number;
    readonly cache_write_tokens?: number;
  } | undefined,
): number | null {
  if (!usage) return null;
  const price = priceFor(model);
  // Anthropic cache pricing: reads 0.1x input, writes 1.25x input (both are counted inside prompt_tokens).
  const cached = Math.min(usage.cached_tokens ?? 0, usage.prompt_tokens);
  const written = Math.min(usage.cache_write_tokens ?? 0, usage.prompt_tokens - cached);
  const inputUnits = usage.prompt_tokens - cached - written + cached * 0.1 + written * 1.25;
  return roundUsd((inputUnits * price.inputPerMTok + usage.completion_tokens * price.outputPerMTok) / 1_000_000);
}

/** Where a settled cost came from: `provider` = reported by the provider, `estimate` = hand-typed prices, `flat` = reviewed flat price. */
export type CostSource = 'provider' | 'estimate' | 'flat';
export interface ActualCost { readonly usd: number; readonly source: CostSource }

/** Settlement cost of a finished LLM call: the provider-reported `usage.cost`, else the hand-typed estimate. */
export function llmActualCost(
  model: string,
  usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cost?: number;
    readonly cached_tokens?: number;
    readonly cache_write_tokens?: number;
  } | undefined,
): ActualCost | null {
  if (usage && typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return { usd: usage.cost, source: 'provider' };
  }
  const usd = llmCostUsd(model, usage);
  return usd === null ? null : { usd, source: 'estimate' };
}

/** numeric(12,6) in the ledger. */
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
