/**
 * Setup for `npm run eval` (vitest.eval.config.ts). Runs before every
 * *.eval.ts file.
 *
 * - Evals call the configured real LLM provider, so fail fast without its key.
 * - `EVAL_MODEL_PROFILE=cheap|free` (opt-in) swaps the extractor, responder,
 *   and judge models for low-cost ones before any provider is constructed.
 *   Unset keeps the normal defaults. See src/services/llm/eval-model-profile.ts.
 * - The repos factory is mocked so `withLlmLogging` never needs a database:
 *   evals measure model behavior, and eval traffic must not land in the
 *   product's `llm_calls` audit table.
 * - pino is quieted to `warn` so the reporter output stays readable;
 *   override with LOG_LEVEL=info to see the per-stage contract logs.
 */
import { afterAll, beforeEach, vi } from 'vitest';
import { beginEvalCase, captureCall, closeEvalLedger } from './ledger';
import { applyEvalModelProfile, evalModelProfile } from '../../src/services/llm/eval-model-profile';

process.env.LOG_LEVEL ??= 'warn';

const provider = process.env.LLM_PROVIDER ?? 'anthropic';
if (provider !== 'openrouter' && provider !== 'anthropic') throw new Error('LLM_PROVIDER must be "openrouter" or "anthropic".');
const requiredKey = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY';
if (!process.env[requiredKey]?.trim()) throw new Error(`Evals call the real LLM: set ${requiredKey} in .env.local (see docs/agents/testing.md → Evals).`);

const profileModels = applyEvalModelProfile(provider);
if (profileModels) {
  console.info(
    `[evals] EVAL_MODEL_PROFILE=${evalModelProfile()} (${provider}): extractor=${profileModels.extractor} responder=${profileModels.responder} judge=${profileModels.judge}`,
  );
}

// Rows are captured so evals can record them in the prompt ledger (see ./ledger.ts).
const llmCalls = { record: async (row: Parameters<typeof captureCall>[0]) => (captureCall(row), 'eval-llm-call') };
vi.mock('../../src/repos', () => ({
  repos: () => ({ llmCalls }),
  systemRepos: () => ({ llmCalls }),
}));
beforeEach(beginEvalCase);
afterAll(closeEvalLedger);
