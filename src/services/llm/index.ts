/**
 * Module-level singleton for the configured ILLMProvider. Mirrors the
 * pattern in src/db/pool.ts: lazy construction inside `getProvider()` so
 * importing this module during build/SSR doesn't explode when env vars
 * aren't set, and a `resetProvider()` for tests that need to swap in a fake.
 */
import { OpenRouterProvider } from './openrouter-provider';
import { AnthropicProvider } from './anthropic-provider';
import type { ILLMProvider } from './types';

export type { ILLMProvider, ModelPurpose, ResolvedModel } from './types';
export type LLMProviderName = 'openrouter' | 'anthropic';

let provider: ILLMProvider | undefined;

export function getProvider(): ILLMProvider {
  if (provider) return provider;
  const selected = selectedProviderName();
  const apiKey = selected === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY
    : process.env.OPENROUTER_API_KEY;
  const keyName = selected === 'anthropic'
    ? 'ANTHROPIC_API_KEY'
    : 'OPENROUTER_API_KEY';
  if (!apiKey?.trim()) {
    throw new Error(`${keyName} is required when LLM_PROVIDER=${selected}.`);
  }
  provider = selected === 'anthropic'
    ? new AnthropicProvider(apiKey.trim())
    : new OpenRouterProvider(apiKey.trim());
  return provider;
}

export function selectedProviderName(): LLMProviderName {
  const selected = process.env.LLM_PROVIDER ?? 'openrouter';
  if (selected !== 'openrouter' && selected !== 'anthropic') {
    throw new Error('LLM_PROVIDER must be "openrouter" or "anthropic".');
  }
  return selected;
}

/** Test hook: swap in a fake or clear the cached singleton. */
export function setProvider(p: ILLMProvider | undefined): void {
  provider = p;
}

/** Test hook: drop the cached singleton so the next `getProvider()` rebuilds. */
export function resetProvider(): void {
  provider = undefined;
}
