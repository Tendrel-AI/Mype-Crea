import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { fromOpenRouterResponse } from '../openrouter-provider';
import { llmActualCost } from '../../usage/policy';

/** Shape of a real OpenRouter completion: the OpenAI fields plus `usage.cost`. */
function response(usage: Record<string, unknown> | undefined): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'gen-1', object: 'chat.completion', created: 1, model: 'google/gemini-2.5-flash',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'hola', refusal: null } }],
    usage,
  } as unknown as OpenAI.Chat.Completions.ChatCompletion;
}

describe('OpenRouter provider-reported cost (D36)', () => {
  it('surfaces usage.cost and settlement uses it as provider cost', () => {
    const completion = fromOpenRouterResponse(response({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.000345, cost_details: { upstream_inference_cost: 0.0003 } }));
    expect(completion.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.000345 });
    expect(llmActualCost('google/gemini-2.5-flash', completion.usage)).toEqual({ usd: 0.000345, source: 'provider' });
  });

  it('omits cost when absent or malformed, so settlement falls back to the marked estimate', () => {
    for (const cost of [undefined, null, 'free', -1, Number.NaN]) {
      const completion = fromOpenRouterResponse(response({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost }));
      expect(completion.usage).not.toHaveProperty('cost');
      expect(llmActualCost('google/gemini-2.5-flash', completion.usage)?.source).toBe('estimate');
    }
  });

  it('has no usage at all when the response carries none', () => {
    expect(fromOpenRouterResponse(response(undefined)).usage).toBeUndefined();
  });
});
