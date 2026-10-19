/**
 * LLM-as-judge for the Responder. Scores what the deterministic checks in
 * `responder.ts` cannot: whether the reply does exactly what the planner's
 * decisions ask (faithfulness) and whether the tone fits the product.
 *
 * Reuses the OpenRouter client from `getProvider()` (no second OpenAI client
 * in the codebase) with a judge model from a different family than the
 * Responder (Gemini), to limit self-preference bias. Override with
 * EVAL_JUDGE_MODEL. Judge calls are eval cost, not product usage, so they do
 * not go through withLlmLogging / llm_calls.
 */
import { z } from 'zod';
import type { PlannerDecision } from '../../src/core/contracts';
import { getProvider } from '../../src/services/llm';
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

export function judgeModel(): string {
  return process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
}

const SYSTEM_PROMPT = [
  'You grade replies of "CreaMype", a Spanish-speaking brand assistant for Peruvian micro and small business owners.',
  'The reply was generated from a list of planner decisions. The decisions are authoritative.',
  '',
  'Score two dimensions from 1 (very poor) to 5 (excellent):',
  '',
  'faithfulness: the reply does exactly what the decisions require, in the listed order, and nothing else.',
  '- request_fields: asks for exactly the listed fields, in one natural question; does not ask for other fields or skip ahead.',
  '- confirm_field: paraphrases the pending value and asks one yes/no question.',
  '- announce_dispatch: briefly says the agent started its work.',
  '- announce_completion: says the result is ready (side panel for images; text options listed literally).',
  '- announce_all_complete: says this step is done and invites the next one.',
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
  const { client } = getProvider().resolve('responder');
  const completion = await client.chat.completions.create({
    model: judgeModel(),
    temperature: 0,
    max_tokens: 600,
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
      { key: 'responder.judge.faithfulness', score: (verdict.faithfulness - 1) / 4, comment: verdict.reasoning },
      { key: 'responder.judge.tone', score: (verdict.tone - 1) / 4 },
    ],
  };
}
