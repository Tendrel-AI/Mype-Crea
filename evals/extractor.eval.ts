/**
 * Extractor eval (Layer 1). Runs every case in `datasets/extractor.ts`
 * through the real ChatInputAdapter + the model of the selected LLM_PROVIDER and scores the
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
import { activePromptVersion } from '../src/services/prompts';
import { getProvider } from '../src/services/llm';
import { evalModelProfile } from '../src/services/llm/eval-model-profile';
import { EVAL_CONVERSATION_ID, evalLlmContext } from './_support/context';
import { recordEvalCase } from './_support/ledger';
import { EXTRACTOR_DATASET_VERSION, extractorCases } from './datasets/extractor';
import { flattenDeltaFields, scoreExtraction, type Feedback } from './evaluators/extractor';

const adapter = new ChatInputAdapter(buildFakeCore(), buildDefaultRegistry());

const extractorVersion = activePromptVersion('extractor');

ls.describe(
  'mypes-extractor',
  () => {
    for (const c of extractorCases) {
      ls.test(
        c.id,
        { inputs: c.inputs, referenceOutputs: c.expected, metadata: { tags: c.tags } },
        async ({ inputs }) => {
          let feedback: ReadonlyArray<Feedback> = [];
          let error: unknown;
          try {
            const delta = await adapter.extract({
              conversationId: EVAL_CONVERSATION_ID,
              userMessage: inputs.userMessage,
              priorDecision: inputs.priorDecision,
              llmContext: evalLlmContext,
            });

            const scored = scoreExtraction(delta, c.expected);
            feedback = scored.feedback;
            for (const f of feedback) ls.logFeedback(f);
            ls.logOutputs({ fields: flattenDeltaFields(delta), intents: delta.intents ?? [] });

            expect(scored.pass, feedback.filter((f) => f.score < 1).map((f) => `${f.key}=${f.score.toFixed(2)} ${f.comment ?? ''}`).join(' | ')).toBe(true);
          } catch (e) {
            error = e;
            throw e;
          } finally {
            await recordEvalCase({ key: 'extractor', version: extractorVersion, caseId: c.id, feedback, error });
          }
        },
      );
    }
  },
  {
    metadata: {
      dataset: EXTRACTOR_DATASET_VERSION,
      model: getProvider().resolve('extractor').modelId,
      modelProfile: evalModelProfile(),
    },
  },
);
