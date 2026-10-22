/**
 * Opt-in low-cost model profiles for LLM evals (`npm run eval*`).
 *
 * `EVAL_MODEL_PROFILE` is read only by the eval setup (`evals/_support/setup.ts`);
 * the app runtime never consults it. Unset or `default` keeps the normal
 * provider defaults and overrides. `cheap` and `free` replace the extractor,
 * responder, and judge models of the selected `LLM_PROVIDER` for the eval
 * process, including any per-purpose model variables already set in
 * `.env.local`, so a copied template can never silently keep the paid models.
 *
 * OpenRouter IDs were checked against the public OpenRouter model catalog on
 * 2026-10-21 (tool calling and forced `tool_choice` supported). Free OpenRouter
 * models are rate-limited and the catalog changes; update this table when one
 * disappears. The direct Anthropic API has no free tier, so both profiles map
 * to Claude Haiku 5.5, its lowest-cost current model.
 */
import type { LLMProviderName } from './index';

export const EVAL_MODEL_PROFILES = ['default', 'cheap', 'free'] as const;
export type EvalModelProfile = (typeof EVAL_MODEL_PROFILES)[number];

export interface EvalModelSelection {
  readonly extractor: string;
  readonly responder: string;
  readonly judge: string;
}

const PROFILE_MODELS: Readonly<
  Record<Exclude<EvalModelProfile, 'default'>, Readonly<Record<LLMProviderName, EvalModelSelection>>>
> = {
  cheap: {
    openrouter: {
      extractor: 'google/gemini-2.5-flash-lite',
      responder: 'google/gemini-2.5-flash-lite',
      judge: 'google/gemini-2.5-flash-lite',
    },
    anthropic: {
      extractor: 'claude-haiku-5-5',
      responder: 'claude-haiku-5-5',
      judge: 'claude-haiku-5-5',
    },
  },
  free: {
    openrouter: {
      extractor: 'google/gemma-4-31b-it:free',
      responder: 'google/gemma-4-31b-it:free',
      judge: 'google/gemma-4-31b-it:free',
    },
    anthropic: {
      extractor: 'claude-haiku-5-5',
      responder: 'claude-haiku-5-5',
      judge: 'claude-haiku-5-5',
    },
  },
};

/** Environment variables each provider reads for per-purpose eval models. */
const MODEL_VARIABLES: Readonly<Record<LLMProviderName, Readonly<Record<keyof EvalModelSelection, string>>>> = {
  openrouter: {
    extractor: 'OPENROUTER_EXTRACTOR_MODEL',
    responder: 'OPENROUTER_RESPONDER_MODEL',
    judge: 'EVAL_JUDGE_MODEL',
  },
  anthropic: {
    extractor: 'ANTHROPIC_EXTRACTOR_MODEL',
    responder: 'ANTHROPIC_RESPONDER_MODEL',
    judge: 'EVAL_JUDGE_MODEL',
  },
};

type Env = Record<string, string | undefined>;

export function evalModelProfile(env: Env = process.env): EvalModelProfile {
  const configured = env.EVAL_MODEL_PROFILE;
  if (configured === undefined || configured === '') return 'default';
  if (!(EVAL_MODEL_PROFILES as readonly string[]).includes(configured)) {
    throw new Error(`EVAL_MODEL_PROFILE must be one of: ${EVAL_MODEL_PROFILES.join(', ')}.`);
  }
  return configured as EvalModelProfile;
}

/** Models a profile selects for one provider; `undefined` for the default profile. */
export function evalProfileModels(
  profile: EvalModelProfile,
  provider: LLMProviderName,
): EvalModelSelection | undefined {
  return profile === 'default' ? undefined : PROFILE_MODELS[profile][provider];
}

/**
 * Apply the configured profile to `env` before any provider is constructed.
 * Returns the applied selection, or `undefined` when the default profile is active.
 */
export function applyEvalModelProfile(
  provider: LLMProviderName,
  env: Env = process.env,
): EvalModelSelection | undefined {
  const models = evalProfileModels(evalModelProfile(env), provider);
  if (!models) return undefined;
  const variables = MODEL_VARIABLES[provider];
  env[variables.extractor] = models.extractor;
  env[variables.responder] = models.responder;
  env[variables.judge] = models.judge;
  return models;
}
