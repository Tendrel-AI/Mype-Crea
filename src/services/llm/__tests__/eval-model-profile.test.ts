import { describe, expect, it } from 'vitest';
import {
  applyEvalModelProfile,
  evalModelProfile,
  evalProfileModels,
} from '../eval-model-profile';
import { isAnthropicModelId, isOpenRouterModelId } from '../model-config';

describe('eval model profile', () => {
  it.each([undefined, '', 'default'])('keeps the normal models when EVAL_MODEL_PROFILE=%j', (value) => {
    const env: Record<string, string | undefined> = {
      EVAL_MODEL_PROFILE: value,
      OPENROUTER_EXTRACTOR_MODEL: 'google/gemini-2.5-flash',
    };
    expect(evalModelProfile(env)).toBe('default');
    expect(applyEvalModelProfile('openrouter', env)).toBeUndefined();
    expect(env).toEqual({ EVAL_MODEL_PROFILE: value, OPENROUTER_EXTRACTOR_MODEL: 'google/gemini-2.5-flash' });
  });

  it.each(['Cheap', 'paid', ' cheap'])('rejects an unknown profile %j', (value) => {
    expect(() => evalModelProfile({ EVAL_MODEL_PROFILE: value })).toThrow(
      'EVAL_MODEL_PROFILE must be one of: default, cheap, free.',
    );
  });

  it('maps the cheap and free profiles per provider and purpose', () => {
    expect(evalProfileModels('cheap', 'openrouter')).toEqual({
      extractor: 'google/gemini-2.5-flash-lite',
      responder: 'google/gemini-2.5-flash-lite',
      judge: 'google/gemini-2.5-flash-lite',
    });
    expect(evalProfileModels('free', 'openrouter')).toEqual({
      extractor: 'google/gemma-4-31b-it:free',
      responder: 'google/gemma-4-31b-it:free',
      judge: 'google/gemma-4-31b-it:free',
    });
    for (const profile of ['cheap', 'free'] as const) {
      expect(evalProfileModels(profile, 'anthropic')).toEqual({
        extractor: 'claude-haiku-5-5',
        responder: 'claude-haiku-5-5',
        judge: 'claude-haiku-5-5',
      });
    }
  });

  it('only selects IDs valid for each provider (no OpenRouter slugs sent to Anthropic)', () => {
    for (const profile of ['cheap', 'free'] as const) {
      expect(Object.values(evalProfileModels(profile, 'openrouter')!).every(isOpenRouterModelId)).toBe(true);
      const anthropic = Object.values(evalProfileModels(profile, 'anthropic')!);
      expect(anthropic.every(isAnthropicModelId)).toBe(true);
      // The Anthropic judge must be a Haiku model because it uses forced tool calls.
      expect(evalProfileModels(profile, 'anthropic')!.judge).toMatch(/^claude-haiku-/);
    }
  });

  it('overrides the selected provider variables only, including values copied from .env.example', () => {
    const env: Record<string, string | undefined> = {
      EVAL_MODEL_PROFILE: 'cheap',
      OPENROUTER_EXTRACTOR_MODEL: 'google/gemini-2.5-flash',
      OPENROUTER_RESPONDER_MODEL: 'google/gemini-2.5-pro',
      ANTHROPIC_RESPONDER_MODEL: 'claude-sonnet-5-5',
    };
    const applied = applyEvalModelProfile('openrouter', env);
    expect(applied?.responder).toBe('google/gemini-2.5-flash-lite');
    expect(env).toEqual({
      EVAL_MODEL_PROFILE: 'cheap',
      OPENROUTER_EXTRACTOR_MODEL: 'google/gemini-2.5-flash-lite',
      OPENROUTER_RESPONDER_MODEL: 'google/gemini-2.5-flash-lite',
      EVAL_JUDGE_MODEL: 'google/gemini-2.5-flash-lite',
      ANTHROPIC_RESPONDER_MODEL: 'claude-sonnet-5-5',
    });

    const anthropicEnv: Record<string, string | undefined> = { EVAL_MODEL_PROFILE: 'free' };
    applyEvalModelProfile('anthropic', anthropicEnv);
    expect(anthropicEnv).toEqual({
      EVAL_MODEL_PROFILE: 'free',
      ANTHROPIC_EXTRACTOR_MODEL: 'claude-haiku-5-5',
      ANTHROPIC_RESPONDER_MODEL: 'claude-haiku-5-5',
      EVAL_JUDGE_MODEL: 'claude-haiku-5-5',
    });
  });
});
