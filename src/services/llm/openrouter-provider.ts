/**
 * OpenRouter-backed ILLMProvider.
 *
 * Holds a single OpenAI client pointed at the OpenRouter API and maps each
 * ModelPurpose to a configured OpenRouter model slug. All orchestrator layers
 * that need an LLM go through this — there must not be another `new OpenAI`
 * call anywhere in app code.
 */
import OpenAI from 'openai';
import { wrapOpenAI } from 'langsmith/wrappers';
import type { ILLMProvider, ModelPurpose, ResolvedModel } from './types';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Per-purpose model configuration. Kept as a plain const so the mapping is
 * obvious at the call site of `resolve`. If a future env override is wanted,
 * read it here, not at the caller.
 */
const MODEL_BY_PURPOSE: Readonly<Record<ModelPurpose, string>> = {
  extractor: 'google/gemini-2.5-flash',
  responder: 'google/gemini-2.5-pro',
};

export class OpenRouterProvider implements ILLMProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    const client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
    });
    this.client = isLangSmithTracingEnabled() ? wrapOpenAI(client) : client;
  }

  resolve(purpose: ModelPurpose): ResolvedModel {
    return {
      client: this.client,
      modelId: MODEL_BY_PURPOSE[purpose],
      purpose,
    };
  }
}

/**
 * LangSmith tracing is dev/eval only (decision 2026-10-04, architecture.md
 * "Evaluation & tracing"): prompts carry tenant business data, so the client
 * is never wrapped in production even if LANGSMITH_TRACING leaks into the
 * production env. `llm_calls` stays the audit source of truth either way.
 */
function isLangSmithTracingEnabled(): boolean {
  return process.env.LANGSMITH_TRACING === 'true' && process.env.NODE_ENV !== 'production';
}
