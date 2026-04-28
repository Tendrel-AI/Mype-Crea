/**
 * Module-level singleton for the configured ILLMProvider. Mirrors the
 * pattern in src/db/pool.ts: lazy construction inside `getProvider()` so
 * importing this module during build/SSR doesn't explode when env vars
 * aren't set, and a `resetProvider()` for tests that need to swap in a fake.
 */
import { OpenRouterProvider } from './openrouter-provider';
import type { ILLMProvider } from './types';

export type { ILLMProvider, ModelPurpose, ResolvedModel } from './types';

let provider: ILLMProvider | undefined;

export function getProvider(): ILLMProvider {
  if (provider) return provider;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. The LLM provider requires an OpenRouter API key.',
    );
  }
  provider = new OpenRouterProvider(apiKey);
  return provider;
}

/** Test hook: swap in a fake or clear the cached singleton. */
export function setProvider(p: ILLMProvider | undefined): void {
  provider = p;
}

/** Test hook: drop the cached singleton so the next `getProvider()` rebuilds. */
export function resetProvider(): void {
  provider = undefined;
}
