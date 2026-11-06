import { describe, expect, it } from 'vitest';
import {
  USAGE_POLICY,
  estimateLlmCostUsd,
  evaluateUsage,
  inputChars,
  llmCostUsd,
  usageLimitMessage,
  type UsageDenialReason,
} from '../policy';

const idle = { committedUsd: 0, userLlmCallsLastHour: 0, userImagesToday: 0 };

describe('USAGE_POLICY (KAN-43, owner-approved 2026-11-02)', () => {
  it('holds the approved pilot values', () => {
    expect(USAGE_POLICY).toMatchObject({
      tenantMonthlyBudgetUsd: 30,
      userLlmCallsPerHour: 60,
      userImagesPerDay: 15,
      maxInputChars: 4000,
    });
  });
});

describe('evaluateUsage', () => {
  it.each([
    ['allowed when idle', idle, { kind: 'llm', estimatedCostUsd: 0.01 }, null],
    ['budget: exactly reaching the cap is allowed', { ...idle, committedUsd: 29.99 }, { kind: 'llm', estimatedCostUsd: 0.01 }, null],
    ['budget: one cent over is denied', { ...idle, committedUsd: 29.99 }, { kind: 'llm', estimatedCostUsd: 0.02 }, 'tenant_budget'],
    ['budget: exhausted denies even a zero-estimate preflight', { ...idle, committedUsd: 30 }, { kind: 'image', estimatedCostUsd: 0 }, 'tenant_budget'],
    ['llm: the 60th call is allowed', { ...idle, userLlmCallsLastHour: 59 }, { kind: 'llm', estimatedCostUsd: 0 }, null],
    ['llm: the 61st call is denied', { ...idle, userLlmCallsLastHour: 60 }, { kind: 'llm', estimatedCostUsd: 0 }, 'user_llm_hourly'],
    ['llm: a two-call turn needs room for both', { ...idle, userLlmCallsLastHour: 59 }, { kind: 'llm', estimatedCostUsd: 0, calls: 2 }, 'user_llm_hourly'],
    ['image: the 15th image is allowed', { ...idle, userImagesToday: 14 }, { kind: 'image', estimatedCostUsd: 0.08 }, null],
    ['image: the 16th image is denied', { ...idle, userImagesToday: 15 }, { kind: 'image', estimatedCostUsd: 0.08 }, 'user_image_daily'],
    ['image counts do not limit llm calls', { ...idle, userImagesToday: 99 }, { kind: 'llm', estimatedCostUsd: 0 }, null],
    ['input: 4000 characters are allowed', idle, { kind: 'llm', estimatedCostUsd: 0, inputChars: 4000 }, null],
    ['input: 4001 characters are denied first', { ...idle, committedUsd: 99 }, { kind: 'llm', estimatedCostUsd: 0, inputChars: 4001 }, 'input_too_long'],
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
  const reasons: UsageDenialReason[] = ['tenant_budget', 'user_llm_hourly', 'user_image_daily', 'input_too_long'];

  it.each(reasons)('%s: neutral Spanish with tuteo, no voseo', (reason) => {
    const message = usageLimitMessage(reason);
    expect(message.length).toBeGreaterThan(20);
    expect(message).not.toMatch(/\b(vos|sos|tenés|querés|podés|avisale|esperá|escribí)\b/i);
  });

  it('uses the owner-approved budget copy', () => {
    expect(usageLimitMessage('tenant_budget')).toBe('Alcanzaste el límite de uso de este mes. Avísale al administrador de tu organización.');
  });
});
