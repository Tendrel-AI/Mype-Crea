import { afterEach, describe, expect, it } from 'vitest';
import { FakeLLMProvider } from '../../../src/core/__tests__/_fixtures/llm';
import { resetProvider, setProvider } from '../../../src/services/llm';
import { judgeModel, judgeReply } from '../judge';

const before = { provider: process.env.LLM_PROVIDER, model: process.env.EVAL_JUDGE_MODEL };
afterEach(() => {
  if (before.provider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = before.provider;
  if (before.model === undefined) delete process.env.EVAL_JUDGE_MODEL;
  else process.env.EVAL_JUDGE_MODEL = before.model;
  resetProvider();
});

describe('provider-aware judge model', () => {
  it('keeps the OpenRouter default and override behavior', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    delete process.env.EVAL_JUDGE_MODEL;
    expect(judgeModel()).toBe('anthropic/claude-sonnet-5');
    process.env.EVAL_JUDGE_MODEL = 'google/gemini-2.5-flash';
    expect(judgeModel()).toBe('google/gemini-2.5-flash');
  });

  it('uses Haiku for Anthropic and rejects models incompatible with forced tool judging', () => {
    process.env.LLM_PROVIDER = 'anthropic';
    delete process.env.EVAL_JUDGE_MODEL;
    expect(judgeModel()).toBe('claude-haiku-5-5');
    process.env.EVAL_JUDGE_MODEL = 'anthropic/claude-sonnet-5';
    expect(() => judgeModel()).toThrow(/Claude Haiku model ID/);
    process.env.EVAL_JUDGE_MODEL = 'claude-sonnet-5-5';
    expect(() => judgeModel()).toThrow(/Claude Haiku model ID/);
  });

  it('rejects blank or malformed OpenRouter overrides', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.EVAL_JUDGE_MODEL = '  ';
    expect(() => judgeModel()).toThrow(/non-empty OpenRouter model slug/);
  });

  it.each(['', '   '])('rejects an empty Anthropic judge override %j', (model) => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.EVAL_JUDGE_MODEL = model;
    expect(() => judgeModel()).toThrow(/Claude Haiku model ID/);
  });

  it('validates provider configuration when resolving a judge model', () => {
    process.env.LLM_PROVIDER = 'other';
    expect(() => judgeModel()).toThrow(/LLM_PROVIDER must be/);
  });

  it('sends a forced tool request and parses the judge verdict offline', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    delete process.env.EVAL_JUDGE_MODEL;
    const fake = new FakeLLMProvider().scriptToolCall('submit_verdict', JSON.stringify({
      faithfulness: 4,
      tone: 5,
      reasoning: 'The answer follows the requested decisions.',
    }));
    setProvider(fake);

    const result = await judgeReply({ decisions: [], reply: 'Perfecto.' });

    expect(result.verdict).toEqual({
      faithfulness: 4,
      tone: 5,
      reasoning: 'The answer follows the requested decisions.',
    });
    const params = fake.captured[0].params as {
      model: string;
      temperature: number;
      tool_choice: unknown;
      tools: Array<{ function: { name: string } }>;
    };
    expect(params.model).toBe('anthropic/claude-sonnet-5');
    expect(params.temperature).toBe(0);
    expect(params.tool_choice).toEqual({ type: 'function', function: { name: 'submit_verdict' } });
    expect(params.tools[0].function.name).toBe('submit_verdict');
  });
});
