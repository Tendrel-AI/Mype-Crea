import { describe, expect, it } from 'vitest';
import {
  USAGE_POLICY,
  estimateLlmCostUsd,
  evaluateUsage,
  inputChars,
  llmActualCost,
  llmCostUsd,
  availableCreditsUsd,
  usageLimitMessage,
  type UsageDenialReason,
} from '../policy';

const idle = { balanceUsd: 10, reservedUsd: 0, userLlmCallsLastHour: 0, userImagesToday: 0 };

describe('USAGE_POLICY (KAN-43, owner-approved 2026-11-02)', () => {
  it('holds the approved pilot values', () => {
    expect(USAGE_POLICY).not.toHaveProperty('tenantMonthlyBudgetUsd');
    expect(USAGE_POLICY).toMatchObject({
      userLlmCallsPerHour: 60,
      userImagesPerDay: 15,
      maxInputChars: 4000,
    });
  });
});

describe('evaluateUsage', () => {
  it.each([
    ['allowed when idle', idle, { kind: 'llm', estimatedCostUsd: 0.01 }, null],
    ['credits: spending exactly the balance is allowed', { ...idle, balanceUsd: 0.01 }, { kind: 'llm', estimatedCostUsd: 0.01 }, null],
    ['credits: one cent over the balance is denied', { ...idle, balanceUsd: 0.01 }, { kind: 'llm', estimatedCostUsd: 0.02 }, 'tenant_credits'],
    ['credits: no balance denies even a zero-estimate preflight', { ...idle, balanceUsd: 0 }, { kind: 'image', estimatedCostUsd: 0 }, 'tenant_credits'],
    ['credits: negative balance fails closed', { ...idle, balanceUsd: -0.5 }, { kind: 'llm', estimatedCostUsd: 0 }, 'tenant_credits'],
    ['credits: in-flight reservations count against the balance', { ...idle, balanceUsd: 1, reservedUsd: 0.9 }, { kind: 'llm', estimatedCostUsd: 0.2 }, 'tenant_credits'],
    ['credits: fully reserved denies', { ...idle, balanceUsd: 1, reservedUsd: 1 }, { kind: 'llm', estimatedCostUsd: 0 }, 'tenant_credits'],
    ['credits: float noise does not deny (0.3 - 0.1 - 0.2)', { ...idle, balanceUsd: 0.3, reservedUsd: 0.1 }, { kind: 'llm', estimatedCostUsd: 0.2 }, null],
    ['llm: the 60th call is allowed', { ...idle, userLlmCallsLastHour: 59 }, { kind: 'llm', estimatedCostUsd: 0 }, null],
    ['llm: the 61st call is denied', { ...idle, userLlmCallsLastHour: 60 }, { kind: 'llm', estimatedCostUsd: 0 }, 'user_llm_hourly'],
    ['llm: a two-call turn needs room for both', { ...idle, userLlmCallsLastHour: 59 }, { kind: 'llm', estimatedCostUsd: 0, calls: 2 }, 'user_llm_hourly'],
    ['image: the 15th image is allowed', { ...idle, userImagesToday: 14 }, { kind: 'image', estimatedCostUsd: 0.08 }, null],
    ['image: the 16th image is denied', { ...idle, userImagesToday: 15 }, { kind: 'image', estimatedCostUsd: 0.08 }, 'user_image_daily'],
    ['image counts do not limit llm calls', { ...idle, userImagesToday: 99 }, { kind: 'llm', estimatedCostUsd: 0 }, null],
    ['input: 4000 characters are allowed', idle, { kind: 'llm', estimatedCostUsd: 0, inputChars: 4000 }, null],
    ['input: 4001 characters are denied first', { ...idle, balanceUsd: 0 }, { kind: 'llm', estimatedCostUsd: 0, inputChars: 4001 }, 'input_too_long'],
  ] as const)('%s', (_name, counters, ask, expected) => {
    expect(evaluateUsage(counters, ask)).toBe(expected);
  });

  it('counts the input cap in Unicode code points', () => {
    expect(inputChars('ñandú 😀')).toBe(7);
  });
});

describe('costs', () => {
  it('estimates an upper bound that covers the real cost of a typical call', () => {
    const request = { model: 'google/gemini-2.5-pro', messages: [{ role: 'user', content: 'x'.repeat(3000) }], max_tokens: 1800 };
    const estimate = estimateLlmCostUsd(request);
    expect(estimate).toBeGreaterThan(llmCostUsd(request.model, { prompt_tokens: 1000, completion_tokens: 1800 })!);
  });

  it('prices unknown models at the conservative default and returns null without usage', () => {
    expect(llmCostUsd('vendor/unknown', { prompt_tokens: 1_000_000, completion_tokens: 0 })).toBe(5);
    expect(llmCostUsd('google/gemini-2.5-flash', undefined)).toBeNull();
  });
});

describe('usageLimitMessage', () => {
  const reasons: UsageDenialReason[] = ['tenant_credits', 'user_llm_hourly', 'user_image_daily', 'input_too_long'];

  it.each(reasons)('%s: neutral Spanish with tuteo, no voseo', (reason) => {
    const message = usageLimitMessage(reason);
    expect(message.length).toBeGreaterThan(20);
    expect(message).not.toMatch(/\b(vos|sos|tenés|querés|podés|avisale|esperá|escribí)\b/i);
  });

  it('uses the owner-approved credits copy', () => {
    expect(usageLimitMessage('tenant_credits')).toBe('Tu organización debe recargar créditos. Avísale al administrador de tu organización.');
  });
});

describe('llmCostUsd cache pricing', () => {
  it('prices cache reads at 0.1x and writes at 1.25x input', () => {
    const base = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    expect(llmCostUsd('claude-sonnet-5-5', base)).toBe(2);
    expect(llmCostUsd('claude-sonnet-5-5', { ...base, cached_tokens: 1_000_000 })).toBe(0.2);
    expect(llmCostUsd('claude-sonnet-5-5', { ...base, cached_tokens: 500_000, cache_write_tokens: 500_000 })).toBe(0.1 + 1.25);
  });
});

describe('llmActualCost (D36)', () => {
  const tokens = { prompt_tokens: 1000, completion_tokens: 100 };
  it('prefers the provider-reported cost, even when zero', () => {
    expect(llmActualCost('google/gemini-2.5-flash', { ...tokens, cost: 0.000123 })).toEqual({ usd: 0.000123, source: 'provider' });
    expect(llmActualCost('google/gemini-2.5-flash', { ...tokens, cost: 0 })).toEqual({ usd: 0, source: 'provider' });
  });
  it('falls back to the hand-typed estimate and marks it, or null without usage', () => {
    expect(llmActualCost('google/gemini-2.5-flash', tokens)).toEqual({ usd: llmCostUsd('google/gemini-2.5-flash', tokens), source: 'estimate' });
    expect(llmActualCost('google/gemini-2.5-flash', { ...tokens, cost: -1 })?.source).toBe('estimate');
    expect(llmActualCost('google/gemini-2.5-flash', undefined)).toBeNull();
  });
  it('availableCreditsUsd is balance minus reserved at ledger precision', () => {
    expect(availableCreditsUsd({ balanceUsd: 0.3, reservedUsd: 0.1 })).toBe(0.2);
  });
});
