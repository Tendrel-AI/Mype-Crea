/**
 * Unit tests for ChatInputAdapter.
 *
 * - The affirmation/denial fast paths must NOT call the LLM.
 * - The LLM extraction path parses the JSON and applies the
 *   STORE_AND_CONFIRM threshold.
 *
 * Mocks the repos factory so withLlmLogging never touches the DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordSpy = vi.fn(async () => 'fake-llm-call-id');
vi.mock('../../repos', () => ({
  repos: () => ({ llmCalls: { record: recordSpy } }),
  systemRepos: () => ({ llmCalls: { record: recordSpy } }),
}));

import { ChatInputAdapter } from '../chat-input-adapter';
import { buildDefaultRegistry } from '../../core/orchestrator/bootstrap-registry';
import { resetProvider, setProvider } from '../../services/llm';
import type { OrchestratorCore, PlannerDecision } from '../../core/contracts';

const ctx = {
  tenant: { id: '00000000-0000-0000-0000-000000000001' },
  user: { id: '00000000-0000-0000-0000-000000000002' },
  conversationId: '00000000-0000-0000-0000-000000000003',
  promptVersion: 'extractor.v1',
};

const conversationId = '00000000-0000-0000-0000-000000000003';

function fakeCore(): OrchestratorCore {
  return {
    applyDelta: async () => ({} as any),
    getNextDecision: async () => ({ kind: 'idle', reason: 'awaiting_user' }) as PlannerDecision,
    getSnapshot: async () => ({} as any),
  };
}

function fakeProvider(scriptedJson: string) {
  return {
    resolve: () => ({
      purpose: 'extractor' as const,
      modelId: 'google/gemini-2.5-flash',
      client: {
        chat: {
          completions: {
            create: vi.fn(async () => ({
              id: 'chatcmpl-fake',
              choices: [{ message: { role: 'assistant', content: scriptedJson } }],
              usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
            })),
          },
        },
      } as any,
    }),
  };
}

describe('ChatInputAdapter', () => {
  beforeEach(() => {
    recordSpy.mockClear();
  });
  afterEach(() => {
    resetProvider();
  });

  it('takes the affirmation fast-path without calling the LLM', async () => {
    const provider = fakeProvider('{}');
    setProvider(provider);
    const registry = buildDefaultRegistry();
    const adapter = new ChatInputAdapter(fakeCore(), registry);

    const priorDecision: PlannerDecision = {
      kind: 'confirm_field',
      agentId: 'name-agent',
      fieldName: 'business_name',
      pendingValue: 'Café Andino',
      reason: 'low_confidence',
    };

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'Sí, confirmo',
      activeAgentId: 'name-agent',
      priorDecision,
      llmContext: ctx,
    });

    expect(delta.fields['name-agent']?.business_name).toEqual({
      value: 'Café Andino',
      confidence: 1.0,
      rawInput: 'Sí, confirmo',
    });
    // No LLM call → no llm_calls row attempt.
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('takes the denial fast-path emitting reset_field intent', async () => {
    const provider = fakeProvider('{}');
    setProvider(provider);
    const registry = buildDefaultRegistry();
    const adapter = new ChatInputAdapter(fakeCore(), registry);

    const priorDecision: PlannerDecision = {
      kind: 'confirm_field',
      agentId: 'name-agent',
      fieldName: 'business_name',
      pendingValue: 'Cafetería Mocha',
      reason: 'low_confidence',
    };

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'No, eso no es',
      activeAgentId: 'name-agent',
      priorDecision,
      llmContext: ctx,
    });

    expect(delta.fields).toEqual({});
    expect(delta.intents).toEqual([
      { kind: 'reset_field', agentId: 'name-agent', fieldName: 'business_name' },
    ]);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('extracts grounded fields from the LLM response and drops low-confidence ones', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        fields: {
          business_name: { value: 'Café Andino', confidence: 0.95 },
          business_profile: { value: 'maybe artisanal coffee', confidence: 0.4 },
        },
      }),
    );
    setProvider(provider);
    const registry = buildDefaultRegistry();
    const adapter = new ChatInputAdapter(fakeCore(), registry);

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'Mi negocio se llama Café Andino, vendemos café orgánico',
      activeAgentId: 'name-agent',
      llmContext: ctx,
    });

    expect(delta.fields['name-agent']?.business_name).toMatchObject({
      value: 'Café Andino',
      confidence: 0.95,
    });
    // 0.4 is below STORE_AND_CONFIRM (0.6) → dropped.
    expect(delta.fields['name-agent']?.business_profile).toBeUndefined();
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  it('returns an empty FieldDelta when the LLM produces no grounded fields', async () => {
    const provider = fakeProvider(JSON.stringify({ fields: {} }));
    setProvider(provider);
    const registry = buildDefaultRegistry();
    const adapter = new ChatInputAdapter(fakeCore(), registry);

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'hola',
      activeAgentId: 'name-agent',
      llmContext: ctx,
    });

    expect(delta.fields).toEqual({});
  });

  it('survives malformed JSON from the LLM', async () => {
    const provider = fakeProvider('this is not json');
    setProvider(provider);
    const registry = buildDefaultRegistry();
    const adapter = new ChatInputAdapter(fakeCore(), registry);

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'no idea',
      activeAgentId: 'name-agent',
      llmContext: ctx,
    });

    expect(delta.fields).toEqual({});
  });
});
