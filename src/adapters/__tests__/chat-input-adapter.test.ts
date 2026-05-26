/**
 * Unit tests for ChatInputAdapter.
 *
 * - The affirmation/denial fast paths must NOT call the LLM.
 * - The LLM extraction path parses the JSON, applies the STORE_AND_CONFIRM
 *   threshold, and fans grounded values out to every agent that requires
 *   the corresponding field.
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
import { resetProvider, setProvider } from '../../services/llm';
import type { PlannerDecision } from '../../core/contracts';
import {
  buildFakeCore,
  buildFixtureCard,
  buildSingleAgentFixtureRegistry,
  FakeLLMProvider,
  fixtureEchoHandler,
  TEST_CONVERSATION_ID,
  TEST_TENANT_ID,
  TEST_USER_ID,
} from '../../core/__tests__/_fixtures';
import { AgentRegistry } from '../../core/orchestrator/agent-registry';

const ctx = {
  tenant: { id: TEST_TENANT_ID },
  user: { id: TEST_USER_ID },
  conversationId: TEST_CONVERSATION_ID,
  promptVersion: 'extractor.v3',
};

const conversationId = TEST_CONVERSATION_ID;

function makeExtractorProvider(toolArguments: string | null): FakeLLMProvider {
  return new FakeLLMProvider({
    purpose: 'extractor',
    modelId: 'google/gemini-2.5-flash',
  }).scriptToolCall('submit_extracted_fields', toolArguments);
}

describe('ChatInputAdapter', () => {
  beforeEach(() => {
    recordSpy.mockClear();
  });
  afterEach(() => {
    resetProvider();
  });

  it('takes the affirmation fast-path without calling the LLM and fans out to every owner of the field', async () => {
    setProvider(makeExtractorProvider('{}'));

    // Two fixture agents both require `business_name`. An affirmation should
    // fan out to both, satisfying the field on each agent at confidence 1.0.
    const registry = new AgentRegistry();
    registry.register(
      buildFixtureCard({ id: 'fixture-a', required: [{ name: 'business_name' }] }),
      fixtureEchoHandler,
      undefined,
    );
    registry.register(
      buildFixtureCard({ id: 'fixture-b', required: [{ name: 'business_name' }] }),
      fixtureEchoHandler,
      undefined,
    );

    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    const priorDecision: PlannerDecision = {
      kind: 'confirm_field',
      agentId: 'fixture-a',
      fieldName: 'business_name',
      pendingValue: 'Café Andino',
      reason: 'low_confidence',
    };

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'Sí, confirmo',
      priorDecision,
      llmContext: ctx,
    });

    expect(delta.fields['fixture-a']?.business_name).toEqual({
      value: 'Café Andino',
      confidence: 1.0,
      rawInput: 'Sí, confirmo',
    });
    expect(delta.fields['fixture-b']?.business_name).toEqual({
      value: 'Café Andino',
      confidence: 1.0,
      rawInput: 'Sí, confirmo',
    });
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('takes the denial fast-path emitting reset_field intents for every owner', async () => {
    setProvider(makeExtractorProvider('{}'));

    const registry = new AgentRegistry();
    registry.register(
      buildFixtureCard({ id: 'fixture-a', required: [{ name: 'business_name' }] }),
      fixtureEchoHandler,
      undefined,
    );
    registry.register(
      buildFixtureCard({ id: 'fixture-b', required: [{ name: 'business_name' }] }),
      fixtureEchoHandler,
      undefined,
    );

    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    const priorDecision: PlannerDecision = {
      kind: 'confirm_field',
      agentId: 'fixture-a',
      fieldName: 'business_name',
      pendingValue: 'Cafetería Mocha',
      reason: 'low_confidence',
    };

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'No, eso no es',
      priorDecision,
      llmContext: ctx,
    });

    expect(delta.fields).toEqual({});
    expect(delta.intents).toEqual([
      { kind: 'reset_field', agentId: 'fixture-a', fieldName: 'business_name' },
      { kind: 'reset_field', agentId: 'fixture-b', fieldName: 'business_name' },
    ]);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('extracts grounded fields, drops low-confidence ones, and fans out to every owner', async () => {
    setProvider(
      makeExtractorProvider(
        JSON.stringify({
          fields: {
            business_name: { value: 'Café Andino', confidence: 0.95 },
            business_profile: { value: 'maybe artisanal coffee', confidence: 0.4 },
          },
        }),
      ),
    );

    const registry = new AgentRegistry();
    registry.register(
      buildFixtureCard({
        id: 'fixture-a',
        required: [{ name: 'business_name' }, { name: 'business_profile' }],
      }),
      fixtureEchoHandler,
      undefined,
    );
    registry.register(
      buildFixtureCard({ id: 'fixture-b', required: [{ name: 'business_name' }] }),
      fixtureEchoHandler,
      undefined,
    );

    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'Mi negocio se llama Café Andino, vendemos café orgánico',
      llmContext: ctx,
    });

    expect(delta.fields['fixture-a']?.business_name).toMatchObject({
      value: 'Café Andino',
      confidence: 0.95,
    });
    expect(delta.fields['fixture-b']?.business_name).toMatchObject({
      value: 'Café Andino',
      confidence: 0.95,
    });
    // 0.4 below STORE_AND_CONFIRM (0.6) → dropped, not present anywhere.
    expect(delta.fields['fixture-a']?.business_profile).toBeUndefined();
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  it('returns an empty FieldDelta when the LLM grounds nothing (all nulls)', async () => {
    // Schema requires every declared field; null = field not expressed.
    setProvider(
      makeExtractorProvider(
        JSON.stringify({
          fields: { business_name: null, business_profile: null, tone: null },
        }),
      ),
    );
    const { registry } = buildSingleAgentFixtureRegistry();
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'hola',
      llmContext: ctx,
    });

    expect(delta.fields).toEqual({});
  });

  it('rejects malformed tool arguments via Zod and emits an empty FieldDelta', async () => {
    setProvider(makeExtractorProvider('this is not json'));
    const { registry } = buildSingleAgentFixtureRegistry();
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'no idea',
      llmContext: ctx,
    });

    expect(delta.fields).toEqual({});
  });

  it('rejects tool arguments that fail the Zod schema (wrong shape)', async () => {
    setProvider(
      makeExtractorProvider(
        JSON.stringify({ fields: { business_name: { value: '', confidence: 1 } } }),
      ),
    );
    const { registry } = buildSingleAgentFixtureRegistry();
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'whatever',
      llmContext: ctx,
    });

    expect(delta.fields).toEqual({});
  });

  it('forces the API call into a single tool call and forwards the JSON schema', async () => {
    const provider = makeExtractorProvider(
      JSON.stringify({
        fields: { business_name: null, business_profile: null, tone: null },
      }),
    );
    setProvider(provider);
    const { registry } = buildSingleAgentFixtureRegistry();
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    await adapter.extract({
      conversationId,
      userMessage: 'hola',
      llmContext: ctx,
    });

    expect(provider.create).toHaveBeenCalledTimes(1);
    const params = provider.create.mock.calls[0][0] as any;
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].type).toBe('function');
    expect(params.tools[0].function.name).toBe('submit_extracted_fields');
    expect(params.tools[0].function.parameters).toMatchObject({
      type: 'object',
      properties: {
        fields: expect.objectContaining({ type: 'object' }),
      },
    });
    expect(params.tool_choice).toEqual({
      type: 'function',
      function: { name: 'submit_extracted_fields' },
    });
    // No json_object response_format: tool_choice is the constraint.
    expect(params.response_format).toBeUndefined();
  });

  it('returns an empty FieldDelta when the model does not call the tool', async () => {
    setProvider(makeExtractorProvider(null));
    const { registry } = buildSingleAgentFixtureRegistry();
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    const delta = await adapter.extract({
      conversationId,
      userMessage: 'no idea',
      llmContext: ctx,
    });

    expect(delta.fields).toEqual({});
  });
});
