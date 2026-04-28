/**
 * LLM provider abstraction.
 *
 * Callers identify what they need by *purpose* (extractor vs responder), not
 * by model id. The provider maps purpose to a concrete OpenAI-compatible
 * client + model id. Adding a new provider (Anthropic-direct, OpenAI-direct,
 * a fake for tests) means adding a new ILLMProvider implementation; nothing
 * else changes.
 *
 * Returning the OpenAI client here is a controlled leak: the entire codebase
 * — including withLlmLogging — speaks the OpenAI protocol, and OpenRouter
 * exposes that protocol natively. Wrapping it in a custom IChatClient would
 * be ceremony with no payoff.
 */
import type OpenAI from 'openai';

/**
 * What the model is being asked to do, NOT which model is configured. Layer
 * 1 of the orchestrator (the FieldDelta extractor) wants a fast, cheap model;
 * layer 4 (the conversational responder) wants a more capable one.
 */
export type ModelPurpose = 'extractor' | 'responder';

export interface ResolvedModel {
  readonly client: OpenAI;
  readonly modelId: string;
  readonly purpose: ModelPurpose;
  /**
   * Optional pinned revision string. When set, callers should pass it to
   * withLlmLogging so the llm_calls audit row records the served revision
   * rather than just the configured id.
   */
  readonly modelRevision?: string;
}

export interface ILLMProvider {
  resolve(purpose: ModelPurpose): ResolvedModel;
}
