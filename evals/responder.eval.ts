/**
 * Responder eval (Layer 4). Renders every plan in `datasets/responder.ts`
 * with the real ChatOutputAdapter + the model of the selected LLM_PROVIDER, then scores the reply
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
import { createCurrentAdapterBehaviorSnapshot } from '../src/services/ai-config/adapter-behavior';
import { getProvider } from '../src/services/llm';
import { evalModelProfile } from '../src/services/llm/eval-model-profile';
import { evalLlmContext } from './_support/context';
import { recordEvalCase } from './_support/ledger';
import { RESPONDER_DATASET_VERSION, responderCases } from './datasets/responder';
import { JUDGE_PROMPT_VERSION, judgeModel, judgeReply } from './evaluators/judge';
import type { Feedback } from './evaluators/extractor';
import { scoreReply } from './evaluators/responder';

const adapter = new ChatOutputAdapter(buildDefaultRegistry());

const responderVersion = createCurrentAdapterBehaviorSnapshot().responder.promptVersion;

ls.describe(
  'mypes-responder',
  () => {
    for (const c of responderCases) {
      ls.test(
        c.id,
        { inputs: c.inputs, referenceOutputs: c.expected, metadata: { tags: c.tags } },
        async ({ inputs }) => {
          const feedback: Feedback[] = [];
          let error: unknown;
          try {
            const { content } = await adapter.render({
              decisions: inputs.decisions,
              recentMessages: inputs.recentMessages,
              snapshot: buildSnapshot({ agentStates: { 'logo-agent': inputs.logoState } }),
              llmContext: evalLlmContext,
            });
            ls.logOutputs({ reply: content });

            const scored = scoreReply(content, c.expected);
            feedback.push(...scored.feedback);
            for (const f of scored.feedback) ls.logFeedback(f);

            const judged = await judgeReply({ decisions: inputs.decisions, reply: content });
            feedback.push(...judged.feedback);
            for (const f of judged.feedback) ls.logFeedback(f);

            expect(scored.pass, `${content}\n→ ${scored.feedback.filter((f) => f.score < 1).map((f) => `${f.key} ${f.comment ?? ''}`).join(' | ')}`).toBe(true);
          } catch (e) {
            error = e;
            throw e;
          } finally {
            await recordEvalCase({ key: 'responder', version: responderVersion, caseId: c.id, feedback, error });
          }
        },
      );
    }
  },
  {
    metadata: {
      dataset: RESPONDER_DATASET_VERSION,
      model: getProvider().resolve('responder').modelId,
      modelProfile: evalModelProfile(),
      judgeModel: judgeModel(),
      judgePrompt: JUDGE_PROMPT_VERSION,
    },
  },
);
