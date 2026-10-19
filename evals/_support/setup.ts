/**
 * Setup for `npm run eval` (vitest.eval.config.ts). Runs before every
 * *.eval.ts file.
 *
 * - Evals call the real LLM through OpenRouter, so fail fast without a key.
 * - The repos factory is mocked so `withLlmLogging` never needs a database:
 *   evals measure model behavior, and eval traffic must not land in the
 *   product's `llm_calls` audit table.
 * - pino is quieted to `warn` so the reporter output stays readable;
 *   override with LOG_LEVEL=info to see the per-stage contract logs.
 */
import { vi } from 'vitest';

process.env.LOG_LEVEL ??= 'warn';

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error(
    'Evals call the real LLM: set OPENROUTER_API_KEY in .env.local (see docs/agents/testing.md → Evals).',
  );
}

vi.mock('../../src/repos', () => ({
  repos: () => ({ llmCalls: { record: async () => 'eval-llm-call' } }),
  systemRepos: () => ({ llmCalls: { record: async () => 'eval-llm-call' } }),
}));
