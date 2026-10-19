/**
 * Responder eval (Layer 4). Renders every plan in `datasets/responder.ts`
 * with the real ChatOutputAdapter + OpenRouter model, then scores the reply
 * twice: deterministic guardrail checks (`evaluators/responder.ts`) and an
 * LLM judge for faithfulness and tone (`evaluators/judge.ts`).
 *
 * A case fails only on the deterministic checks; judge scores are logged as
 * feedback for trend comparison, since single judge scores are noisy.
 *
 * Run: npm run eval:responder   (costs LLM tokens; see docs/agents/testing.md)
 * One case: npm run eval:responder -- -t "confirm-name"
 */
import * as ls from 'langsmith/vitest';
import { expect } from 'vitest';
import { ChatOutputAdapter } from '../src/adapters/chat-output-adapter';
import { buildDefaultRegistry } from '../src/core/orchestrator/bootstrap-registry';
import { buildSnapshot } from '../src/core/__tests__/_fixtures/snapshot';
import { getProvider } from '../src/services/llm';
import { evalLlmContext } from './_support/context';
import { RESPONDER_DATASET_VERSION, responderCases } from './datasets/responder';
import { JUDGE_PROMPT_VERSION, judgeModel, judgeReply } from './evaluators/judge';
import { scoreReply } from './evaluators/responder';

const adapter = new ChatOutputAdapter(buildDefaultRegistry());

ls.describe(
  'mypes-responder',
  () => {
    for (const c of responderCases) {
      ls.test(
        c.id,
        { inputs: c.inputs, referenceOutputs: c.expected, metadata: { tags: c.tags } },
        async ({ inputs }) => {
          const { content } = await adapter.render({
            decisions: inputs.decisions,
            recentMessages: inputs.recentMessages,
            snapshot: buildSnapshot({ agentStates: { 'logo-agent': inputs.logoState } }),
            llmContext: evalLlmContext,
          });
          ls.logOutputs({ reply: content });

          const { pass, feedback } = scoreReply(content, c.expected);
          for (const f of feedback) ls.logFeedback(f);

          const judged = await judgeReply({ decisions: inputs.decisions, reply: content });
          for (const f of judged.feedback) ls.logFeedback(f);

          expect(pass, `${content}\n→ ${feedback.filter((f) => f.score < 1).map((f) => `${f.key} ${f.comment ?? ''}`).join(' | ')}`).toBe(true);
        },
      );
    }
  },
  {
    metadata: {
      dataset: RESPONDER_DATASET_VERSION,
      model: getProvider().resolve('responder').modelId,
      judgeModel: judgeModel(),
      judgePrompt: JUDGE_PROMPT_VERSION,
    },
  },
);
