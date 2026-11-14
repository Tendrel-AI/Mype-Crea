/**
 * LLM-as-judge for the Responder. Scores what the deterministic checks in
 * `responder.ts` cannot: whether the reply does exactly what the planner's
 * decisions ask (faithfulness) and whether the tone fits the product.
 *
 * Reuses the configured provider from `getProvider()` (no second client
 * in the codebase). OpenRouter uses a Claude judge against Gemini responses;
 * Anthropic mode uses Haiku to judge Sonnet responses. Override with
 * EVAL_JUDGE_MODEL. Judge calls are eval cost, not product usage, so they do
 * not go through withLlmLogging / llm_calls.
 */
import { z } from 'zod';
import type { PlannerDecision } from '../../src/core/contracts';
import { getProvider, selectedProviderName, type LLMProviderName } from '../../src/services/llm';
import type { Feedback } from './extractor';

export const JUDGE_PROMPT_VERSION = 'judge.responder.v1';
const DEFAULT_JUDGE_MODEL = 'anthropic/claude-sonnet-5';
const TOOL_NAME = 'submit_verdict';

const VerdictZ = z.object({
  faithfulness: z.number().int().min(1).max(5),
  tone: z.number().int().min(1).max(5),
  reasoning: z.string(),
});

export type Verdict = z.infer<typeof VerdictZ>;

export function judgeModel(provider: LLMProviderName = selectedProviderName()): string {
  const configured = process.env.EVAL_JUDGE_MODEL;
  if (provider === 'anthropic') {
    if (configured !== undefined && !/^claude-haiku-[a-z0-9-]+$/i.test(configured.trim())) {
      throw new Error(
        'EVAL_JUDGE_MODEL must be a Claude Haiku model ID when LLM_PROVIDER=anthropic; the judge requires forced tool use.',
      );
    }
    return configured?.trim() ?? 'claude-haiku-5-5';
  }
  if (configured !== undefined && (!configured.trim() || configured.trim().includes(' '))) {
    throw new Error('EVAL_JUDGE_MODEL must be a non-empty OpenRouter model slug.');
  }
  return configured?.trim() ?? DEFAULT_JUDGE_MODEL;
}

const SYSTEM_PROMPT = [
  'You grade replies of "CreaMype", a Spanish-speaking brand assistant for Peruvian micro and small business owners.',
  'The reply was generated from a list of planner decisions. The decisions are authoritative.',
  '',
  'Score two dimensions from 1 (very poor) to 5 (excellent):',
  '',
  'faithfulness: the reply does exactly what the decisions require, in the listed order, and nothing else.',
  '- request_fields: asks for exactly the listed fields, in one natural question; does not ask for other fields or skip ahead.',
  '- confirm_fields: paraphrases the pending values and asks one yes/no question for all of them.',
  '- offer_generation: says everything is ready and invites the user to tap the Generar button; it must NOT claim generation already started.',
  '- announce_dispatch: briefly says the agent started its work.',
  '- A change or approval requested in chat must be guided to the panel buttons (Iterar, Aprobar); claiming the change was made is unfaithful.',
  '- announce_completion: says the result is ready (side panel for images; text options listed literally).',
  '- report_deliverable_status: tells the user what to do in the panel (Aprobar/Iterar, Reintentar) or that the deliverable is being generated; asks no question.',
  '- announce_all_complete: says the brand/product data is ready and points to «Nuevo producto» or the panel; asks no question and never says "¿seguimos?".',
  '- Penalize invented facts, names, colors or promises not present in the decisions.',
  '',
  'tone: warm, professional and direct; neutral Latin-American Spanish using "tú" (tuteo).',
  '- Voseo ("querés", "contame", "vos") or Spain-only Spanish ("vosotros", "vale") caps tone at 2.',
  '- Greetings, filler ("dame un momento") or more than two sentences lower the score.',
  '',
  `Call ${TOOL_NAME} exactly once.`,
].join('\n');

export async function judgeReply(input: {
  readonly decisions: ReadonlyArray<PlannerDecision>;
  readonly reply: string;
}): Promise<{ verdict: Verdict; feedback: ReadonlyArray<Feedback> }> {
  const resolved = getProvider().resolve('extractor');
  const selectedProvider = resolved.provider ?? selectedProviderName();
  const selectedModel = judgeModel(selectedProvider);
  const { client } = resolved;
  const completion = await client.chat.completions.create({
    model: selectedModel,
    max_tokens: 600,
    ...(selectedProvider === 'anthropic' ? {} : { temperature: 0 }),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Decisions (JSON):\n${JSON.stringify(input.decisions, null, 2)}\n\nReply to grade:\n"""${input.reply}"""`,
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: TOOL_NAME,
          description: 'Submit the scores for the reply.',
          parameters: z.toJSONSchema(VerdictZ, { target: 'draft-7' }) as Record<string, unknown>,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: TOOL_NAME } },
  });

  const call = completion.choices[0]?.message?.tool_calls?.[0];
  const raw = call && call.type === 'function' ? call.function.arguments : '';
  const verdict = VerdictZ.parse(JSON.parse(raw));
  return {
    verdict,
    feedback: [
      {
        key: 'responder.judge.faithfulness',
        score: (verdict.faithfulness - 1) / 4,
        comment: verdict.reasoning,
      },
      { key: 'responder.judge.tone', score: (verdict.tone - 1) / 4 },
    ],
  };
}
