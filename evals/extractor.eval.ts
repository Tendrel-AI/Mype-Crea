/**
 * Extractor eval (Layer 1). Runs every case in `datasets/extractor.ts`
 * through the real ChatInputAdapter + OpenRouter model and scores the
 * produced FieldDelta with the deterministic scorers.
 *
 * Run: npm run eval:extractor   (costs LLM tokens; see docs/agents/testing.md)
 * One case: npm run eval:extractor -- -t "hedged-name"
 */
import * as ls from 'langsmith/vitest';
import { expect } from 'vitest';
import { ChatInputAdapter } from '../src/adapters/chat-input-adapter';
import { buildDefaultRegistry } from '../src/core/orchestrator/bootstrap-registry';
import { buildFakeCore } from '../src/core/__tests__/_fixtures/core';
import { getProvider } from '../src/services/llm';
import { EVAL_CONVERSATION_ID, evalLlmContext } from './_support/context';
import { EXTRACTOR_DATASET_VERSION, extractorCases } from './datasets/extractor';
import { flattenDeltaFields, scoreExtraction } from './evaluators/extractor';

const adapter = new ChatInputAdapter(buildFakeCore(), buildDefaultRegistry());

ls.describe(
  'mypes-extractor',
  () => {
    for (const c of extractorCases) {
      ls.test(
        c.id,
        { inputs: c.inputs, referenceOutputs: c.expected, metadata: { tags: c.tags } },
        async ({ inputs }) => {
          const delta = await adapter.extract({
            conversationId: EVAL_CONVERSATION_ID,
            userMessage: inputs.userMessage,
            priorDecision: inputs.priorDecision,
            llmContext: evalLlmContext,
          });

          const { pass, feedback } = scoreExtraction(delta, c.expected);
          for (const f of feedback) ls.logFeedback(f);
          ls.logOutputs({ fields: flattenDeltaFields(delta), intents: delta.intents ?? [] });

          expect(pass, feedback.filter((f) => f.score < 1).map((f) => `${f.key}=${f.score.toFixed(2)} ${f.comment ?? ''}`).join(' | ')).toBe(true);
        },
      );
    }
  },
  {
    metadata: {
      dataset: EXTRACTOR_DATASET_VERSION,
      model: getProvider().resolve('extractor').modelId,
    },
  },
);
