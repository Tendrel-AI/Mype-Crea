/**
 * Unit tests for ChatInputAdapter.
 *
 * - The affirmation/denial fast paths must NOT call the LLM, and only a bare
 *   yes/no takes them.
 * - Compound replies to confirm_fieldss (yes/no plus a correction or extra
 *   facts) are extracted, and the resulting delta is merged into a real
 *   in-memory store so the tests assert the final slot state (KAN-56).
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

import { ChatInputAdapter, classifyConfirmationReply } from '../chat-input-adapter';
import { resetProvider, setProvider } from '../../services/llm';
import {
  CONFIDENCE_THRESHOLDS,
  type ConfirmFieldsDecision,
  type PlannerDecision,
} from '../../core/contracts';
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
import { InMemoryConversationStore } from '../../core/orchestrator/in-memory-store';
import { mergeFieldDelta } from '../../core/orchestrator/merge';
import { createCurrentAdapterBehaviorSnapshot } from '../../services/ai-config/adapter-behavior';
import { DELEGATED_FIELD_VALUE } from '../../core/brief';

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
      kind: 'confirm_fields',
      entries: [{ agentId: 'fixture-a', fieldName: 'business_name', pendingValue: 'Café Andino' }],
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
      expectedPendingValue: 'Café Andino',
    });
    expect(delta.fields['fixture-b']?.business_name).toEqual({
      value: 'Café Andino',
      confidence: 1.0,
      rawInput: 'Sí, confirmo',
      expectedPendingValue: 'Café Andino',
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
      kind: 'confirm_fields',
      entries: [{ agentId: 'fixture-a', fieldName: 'business_name', pendingValue: 'Cafetería Mocha' }],
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
      { kind: 'reset_field', agentId: 'fixture-a', fieldName: 'business_name', expectedPendingValue: 'Cafetería Mocha' },
      { kind: 'reset_field', agentId: 'fixture-b', fieldName: 'business_name', expectedPendingValue: 'Cafetería Mocha' },
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

  it('lists the asked fields (number -> field -> hint) in the system prompt after a request_fields, and stores «Sin preferencia» as given', async () => {
    const provider = makeExtractorProvider(
      JSON.stringify({ fields: { a_field: { value: 'Azul', confidence: 1 }, b_field: { value: 'Sin preferencia', confidence: 1 }, c_field: null } }),
    );
    setProvider(provider);
    const registry = new AgentRegistry();
    registry.register(
      buildFixtureCard({ id: 'fixture-a', required: [{ name: 'a_field', promptHint: 'Hint A' }, { name: 'b_field', promptHint: 'Hint B' }, { name: 'c_field', promptHint: 'Hint C' }] }),
      fixtureEchoHandler,
      undefined,
    );
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);
    const prior: PlannerDecision = {
      kind: 'request_fields',
      agentId: 'fixture-a' as never,
      fields: [
        { fieldName: 'c_field' as never, promptHint: 'Hint C' },
        { fieldName: 'a_field' as never, promptHint: 'Hint A' },
        { fieldName: 'b_field' as never, promptHint: 'Hint B' },
      ],
    };

    const delta = await adapter.extract({ conversationId, userMessage: '2. Azul, 3. no aplica', priorDecision: prior, llmContext: ctx });

    const prompt = provider.captured[0].systemPrompt;
    expect(prompt).toContain('Preguntas pendientes:');
    expect(prompt).toContain('Todo campo pendiente que el mensaje no aborde se devuelve con null');
    expect(prompt).toContain('"answers_pending" es true solo si el mensaje responde');
    expect(prompt).toContain('  1. c_field: Hint C\n  2. a_field: Hint A\n  3. b_field: Hint B');
    // Neither field is delegable: the answer is stored as given.
    expect(delta.fields['fixture-a']?.b_field).toMatchObject({ value: 'Sin preferencia', confidence: 1 });

    await adapter.extract({ conversationId, userMessage: 'hola', llmContext: ctx });
    expect(provider.captured[1].systemPrompt).not.toContain('Preguntas pendientes:');

    // Prompt caching: the pending-questions block is last, so the prefix before it is identical across turns.
    const withAsked = provider.captured[0].systemPrompt;
    const without = provider.captured[1].systemPrompt;
    const askedAt = withAsked.indexOf('\n\nPreguntas pendientes:');
    expect(askedAt).toBeGreaterThan(withAsked.indexOf('Reglas:'));
    expect(withAsked.slice(0, askedAt)).toBe(without);
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

  it('takes the prompt from the frozen file and the model/settings/fields from the execution (D22)', async () => {
    const provider = makeExtractorProvider(JSON.stringify({ fields: { business_name: null, business_profile: null, tone: null } }));
    const { registry } = buildSingleAgentFixtureRegistry();
    const fields = registry.getFieldSchemas().flatMap((schema) => [
      ...schema.requiredFields.map((name) => ({
        name,
        required: true,
        promptHint: registry.getPromptHint(schema.agentId, name),
        agents: [schema.agentId],
      })),
      ...schema.optionalFields.map((name) => ({
        name,
        required: false,
        promptHint: registry.getPromptHint(schema.agentId, name),
        agents: [schema.agentId],
      })),
    ]);
    const behavior = createCurrentAdapterBehaviorSnapshot(fields);
    const frozen = {
      ...behavior,
      extractor: {
        ...behavior.extractor,
        promptTemplate: 'ignored: the manifest no longer supplies the prompt',
      },
    };
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    await adapter.extract({
      conversationId,
      userMessage: 'hola',
      llmContext: ctx,
      execution: { model: { ...provider.resolve('extractor'), provider: 'anthropic', modelId: 'claude-haiku-5-5' }, behavior: frozen },
    });

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.captured[0].systemPrompt).not.toContain('ignored');
    expect(provider.captured[0].systemPrompt).toContain('submit_extracted_fields');
    expect((provider.create.mock.calls[0][0] as any).temperature).toBe(0);
    // KAN-69 A6: the llm_calls row carries the execution's effective provenance.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect((recordSpy.mock.calls[0] as any[])[0]).toMatchObject({
      provider: 'anthropic',
      purpose: 'extractor',
      model: 'claude-haiku-5-5',
      inputTokens: 5,
      outputTokens: 10,
    });
  });

  it('ignores the release-frozen extractor fields and uses the registry ones (D22)', async () => {
    const provider = makeExtractorProvider('{}');
    const { registry } = buildSingleAgentFixtureRegistry();
    const stale = { name: 'ghost_field', required: false, promptHint: '¿Fantasma?', agents: ['test-fixture-agent'] };
    const behavior = createCurrentAdapterBehaviorSnapshot([stale]);
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    await adapter.extract({
      conversationId,
      userMessage: 'hola',
      llmContext: ctx,
      execution: { model: { ...provider.resolve('extractor'), provider: 'openrouter' }, behavior },
    });

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.captured[0].systemPrompt).not.toContain('ghost_field');
    expect(provider.captured[0].systemPrompt).toContain('business_name');
  });

  it('accepts a frozen field whose owners or required flag changed (a new card shares it)', async () => {
    const provider = makeExtractorProvider('{"fields":{}}');
    const { registry } = buildSingleAgentFixtureRegistry();
    // Same name and hint as the fixture registry; optional and owned by another agent when frozen.
    const behavior = createCurrentAdapterBehaviorSnapshot([
      { name: 'business_name', required: false, promptHint: '¿Cómo se llama el negocio?', agents: ['some-older-owner'] },
    ]);
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);

    await adapter.extract({
      conversationId,
      userMessage: 'hola',
      llmContext: ctx,
      execution: { model: { ...provider.resolve('extractor'), provider: 'openrouter' }, behavior },
    });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// KAN-56: compound replies to confirm_fields
// ---------------------------------------------------------------------------

const PENDING_NAME = 'Dulce Hogar';
/** Confidence of the stored pending value: between STORE_AND_CONFIRM and AUTO_ACCEPT. */
const PENDING_CONFIDENCE = 0.7;
const AGENT = 'fixture-a';

const confirmName: ConfirmFieldsDecision = {
  kind: 'confirm_fields',
  entries: [{ agentId: AGENT, fieldName: 'business_name', pendingValue: PENDING_NAME }],
  reason: 'low_confidence',
};

type ToolField = { value: string; confidence: number } | null;

/** Tool arguments with every registered field present (null unless given). */
function toolArgs(fields: Record<string, ToolField> = {}): string {
  return JSON.stringify({
    fields: { business_name: null, color_palette: null, style_keywords: null, ...fields },
  });
}

/**
 * One confirm_fields turn end to end through the adapter and the real merge:
 * the store holds `business_name` pending as "Dulce Hogar", the user replies,
 * the (mocked) extractor answers with `llmArgs`, and the delta is merged.
 */
async function runConfirmTurn(userMessage: string, llmArgs: string = toolArgs()) {
  const provider = makeExtractorProvider(llmArgs);
  setProvider(provider);

  const registry = new AgentRegistry();
  registry.register(
    buildFixtureCard({
      id: AGENT,
      required: [{ name: 'business_name' }, { name: 'style_keywords' }],
      optional: [{ name: 'color_palette' }],
    }),
    fixtureEchoHandler,
    undefined,
  );
  const store = new InMemoryConversationStore(registry.getFieldSchemas());
  await store.getOrCreate(conversationId, TEST_TENANT_ID, TEST_USER_ID);
  await store.updateFieldSlot(conversationId, AGENT, 'business_name', true, {
    status: 'pending_confirmation',
    value: PENDING_NAME,
    confidence: PENDING_CONFIDENCE,
  });

  const adapter = new ChatInputAdapter(buildFakeCore(), registry);
  const delta = await adapter.extract({
    conversationId,
    userMessage,
    priorDecision: confirmName,
    llmContext: ctx,
  });
  await mergeFieldDelta(delta, store, registry);
  const snapshot = await store.get(conversationId);
  const state = snapshot!.agentStates[AGENT];
  return { delta, provider, state };
}

describe('ChatInputAdapter — replies to confirm_fields (KAN-56)', () => {
  beforeEach(() => {
    recordSpy.mockClear();
  });
  afterEach(() => {
    resetProvider();
  });

  describe('classifyConfirmationReply', () => {
    it.each([
      ['sí', 'affirm'],
      ['Si', 'affirm'],
      ['correcto', 'affirm'],
      ['dale', 'affirm'],
      ['Sí, así es', 'affirm'],
      ['¡Claro que sí!', 'affirm'],
      ['ok, gracias', 'affirm'],
      ['Sí, confirmo.', 'affirm'],
      ['no', 'deny'],
      ['No, ese no es.', 'deny'],
      ['no es correcto', 'deny'],
      ['No, gracias', 'deny'],
    ] as const)('"%s" is a simple %s', (message, polarity) => {
      expect(classifyConfirmationReply(message)).toEqual({ polarity, simple: true });
    });

    it.each([
      ['Sí, pero el nombre es Dulce Casa', 'affirm'],
      ['Sí, y los colores que quiero son azul y blanco.', 'affirm'],
      ['dale, y el estilo es moderno', 'affirm'],
      ['No, se llama Dulce Casa.', 'deny'],
      ['no, es Dulce Casa y además vendo panes', 'deny'],
      ['Sinceramente prefiero Casa Dulce.', 'none'],
      ['sí, no', 'none'],
      ['gracias', 'none'],
      ['👍', 'none'],
    ] as const)('"%s" is compound with polarity %s', (message, polarity) => {
      expect(classifyConfirmationReply(message)).toEqual({ polarity, simple: false });
    });
  });

  it.each(['sí', 'correcto', 'dale', 'Sí, así es.', 'ok, gracias'])(
    'plain affirmation "%s": no LLM call, pending value confirmed',
    async (message) => {
      const { provider, state } = await runConfirmTurn(message);

      expect(provider.create).not.toHaveBeenCalled();
      expect(recordSpy).not.toHaveBeenCalled();
      expect(state.requiredFields.business_name).toEqual({
        status: 'filled',
        value: PENDING_NAME,
        confidence: 1.0,
        source: 'chat-es',
      });
    },
  );

  it.each(['no', 'No, ese no es.', 'no es correcto'])(
    'plain denial "%s": no LLM call, field reset to empty',
    async (message) => {
      const { provider, state } = await runConfirmTurn(message);

      expect(provider.create).not.toHaveBeenCalled();
      expect(recordSpy).not.toHaveBeenCalled();
      expect(state.requiredFields.business_name).toEqual({ status: 'empty' });
    },
  );

  it('affirmation + correction: the corrected value is stored and the pending one is never confirmed', async () => {
    const { delta, provider, state } = await runConfirmTurn(
      'Sí, pero el nombre es Dulce Casa',
      toolArgs({ business_name: { value: 'Dulce Casa', confidence: 0.95 } }),
    );

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(delta.intents).toEqual([
      { kind: 'reset_field', agentId: AGENT, fieldName: 'business_name' },
    ]);
    expect(state.requiredFields.business_name).toEqual({
      status: 'filled',
      value: 'Dulce Casa',
      confidence: 0.95,
      source: 'chat-es',
    });
  });

  it('affirmation + hedged correction: the corrected value goes back to confirmation, not the old one', async () => {
    const { state } = await runConfirmTurn(
      'Sí, aunque creo que mejor es Dulce Casa',
      toolArgs({ business_name: { value: 'Dulce Casa', confidence: 0.75 } }),
    );

    expect(state.requiredFields.business_name).toEqual({
      status: 'pending_confirmation',
      value: 'Dulce Casa',
      confidence: 0.75,
      source: 'chat-es',
    });
  });

  it('affirmation contradicted by a value too uncertain to keep: field reset, pending value not confirmed', async () => {
    const { delta, state } = await runConfirmTurn(
      'Sí, bueno, tal vez algo como Dulce Casa',
      toolArgs({ business_name: { value: 'Dulce Casa', confidence: 0.4 } }),
    );

    expect(delta.intents).toEqual([
      { kind: 'reset_field', agentId: AGENT, fieldName: 'business_name', expectedPendingValue: PENDING_NAME },
    ]);
    expect(state.requiredFields.business_name).toEqual({ status: 'empty' });
  });

  it('denial + correction: reset plus the corrected value, and merge stores the correction', async () => {
    const { delta, provider, state } = await runConfirmTurn(
      'No, se llama Dulce Casa.',
      toolArgs({ business_name: { value: 'Dulce Casa', confidence: 1.0 } }),
    );

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(delta.intents).toEqual([
      { kind: 'reset_field', agentId: AGENT, fieldName: 'business_name' },
    ]);
    expect(delta.fields[AGENT]?.business_name).toMatchObject({ value: 'Dulce Casa', confidence: 1.0 });
    expect(state.requiredFields.business_name).toEqual({
      status: 'filled',
      value: 'Dulce Casa',
      confidence: 1.0,
      source: 'chat-es',
    });
  });

  it('denial + correction + extra fact: both are stored', async () => {
    const { state } = await runConfirmTurn(
      'No, es Dulce Casa y quiero un estilo moderno',
      toolArgs({
        business_name: { value: 'Dulce Casa', confidence: 0.95 },
        style_keywords: { value: 'moderno', confidence: 0.95 },
      }),
    );

    expect(state.requiredFields.business_name).toMatchObject({ status: 'filled', value: 'Dulce Casa' });
    expect(state.requiredFields.style_keywords).toMatchObject({ status: 'filled', value: 'moderno' });
  });

  it('denial + extra fact without a replacement: field reset, extra fact stored', async () => {
    const { delta, state } = await runConfirmTurn(
      'No, pero los colores son azul y blanco',
      toolArgs({ color_palette: { value: 'azul y blanco', confidence: 0.95 } }),
    );

    expect(delta.intents).toEqual([
      { kind: 'reset_field', agentId: AGENT, fieldName: 'business_name', expectedPendingValue: PENDING_NAME },
    ]);
    expect(state.requiredFields.business_name).toEqual({ status: 'empty' });
    expect(state.optionalFields.color_palette).toMatchObject({ status: 'filled', value: 'azul y blanco' });
  });

  it('denial that restates the pending value: denial wins, field reset', async () => {
    const { state } = await runConfirmTurn(
      'No, Dulce Hogar no me convence',
      toolArgs({ business_name: { value: 'Dulce Hogar', confidence: 0.8 } }),
    );

    expect(state.requiredFields.business_name).toEqual({ status: 'empty' });
  });

  it('affirmation + extra allowed fact: pending value confirmed and the extra fact stored', async () => {
    const { delta, provider, state } = await runConfirmTurn(
      'Sí, y los colores que quiero son azul y blanco.',
      toolArgs({ color_palette: { value: 'azul y blanco', confidence: 0.95 } }),
    );

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(delta.intents).toBeUndefined();
    expect(state.requiredFields.business_name).toEqual({
      status: 'filled',
      value: PENDING_NAME,
      confidence: 1.0,
      source: 'chat-es',
    });
    expect(state.optionalFields.color_palette).toEqual({
      status: 'filled',
      value: 'azul y blanco',
      confidence: 0.95,
      source: 'chat-es',
    });
  });

  it('affirmation that restates the same value (different case): confirmed at 1.0', async () => {
    const { state } = await runConfirmTurn(
      'Sí, dulce hogar, y el estilo es rústico',
      toolArgs({
        business_name: { value: 'dulce hogar', confidence: 0.8 },
        style_keywords: { value: 'rústico', confidence: 0.95 },
      }),
    );

    expect(state.requiredFields.business_name).toEqual({
      status: 'filled',
      value: PENDING_NAME,
      confidence: 1.0,
      source: 'chat-es',
    });
    expect(state.requiredFields.style_keywords).toMatchObject({ status: 'filled', value: 'rústico' });
  });

  it('compound message with a disallowed field: the unknown field is rejected, the rest is applied', async () => {
    const { delta, state } = await runConfirmTurn(
      'Sí, y el precio de mi pan es 2 soles',
      JSON.stringify({
        fields: {
          business_name: null,
          color_palette: null,
          style_keywords: null,
          price: { value: '2 soles', confidence: 1.0 },
        },
      }),
    );

    expect(Object.keys(delta.fields[AGENT] ?? {})).toEqual(['business_name']);
    expect(state.requiredFields.business_name).toEqual({
      status: 'filled',
      value: PENDING_NAME,
      confidence: 1.0,
      source: 'chat-es',
    });
    expect(state.requiredFields).not.toHaveProperty('price');
    expect(state.optionalFields).not.toHaveProperty('price');
  });

  it('reply with no yes/no cue: plain extraction, pending value left unconfirmed', async () => {
    const { delta, state } = await runConfirmTurn(
      'Mis colores son azul y blanco',
      toolArgs({ color_palette: { value: 'azul y blanco', confidence: 0.95 } }),
    );

    expect(delta.intents).toBeUndefined();
    expect(state.requiredFields.business_name).toEqual({
      status: 'pending_confirmation',
      value: PENDING_NAME,
      confidence: PENDING_CONFIDENCE,
    });
    expect(state.optionalFields.color_palette).toMatchObject({ status: 'filled' });
  });

  it('ambiguous "sí, no": extracted, and the pending value is not confirmed', async () => {
    const { provider, state } = await runConfirmTurn('sí, no');

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(state.requiredFields.business_name).toEqual({
      status: 'pending_confirmation',
      value: PENDING_NAME,
      confidence: PENDING_CONFIDENCE,
    });
  });

  it.each([
    ['No, creo que es Dulce Casa'],
    ['Sí, aunque creo que es Dulce Casa'],
  ])(
    'a correction less confident than the stored pending value still replaces it: "%s"',
    async (message) => {
      // The adapter emits reset_field next to the correction and merge applies
      // resets before values, so the old value cannot win the conflict check.
      const correctionConfidence = CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM + 0.05;
      expect(correctionConfidence).toBeLessThan(PENDING_CONFIDENCE);
      const { delta, state } = await runConfirmTurn(
        message,
        toolArgs({ business_name: { value: 'Dulce Casa', confidence: correctionConfidence } }),
      );

      expect(delta.intents).toEqual([
        { kind: 'reset_field', agentId: AGENT, fieldName: 'business_name' },
      ]);
      expect(state.requiredFields.business_name).toEqual({
        status: 'pending_confirmation',
        value: 'Dulce Casa',
        confidence: correctionConfidence,
        source: 'chat-es',
      });
    },
  );
});


// ---------------------------------------------------------------------------
// D35: answers_pending + delegable fields
// ---------------------------------------------------------------------------

describe('ChatInputAdapter — delegable fields (D35)', () => {
  beforeEach(() => {
    recordSpy.mockClear();
  });
  afterEach(() => {
    resetProvider();
  });

  const asked: PlannerDecision = {
    kind: 'request_fields',
    agentId: 'fixture-a' as never,
    fields: [
      { fieldName: 'goal' as never, promptHint: 'Hint goal' },
      { fieldName: 'shapes' as never, promptHint: 'Hint shapes' },
      { fieldName: 'keep' as never, promptHint: 'Hint keep' },
      { fieldName: 'refs' as never, promptHint: 'Hint refs' },
    ],
  };

  function setup(fields: Record<string, ToolField>, answersPending: boolean | undefined) {
    const provider = makeExtractorProvider(
      JSON.stringify({
        fields: { goal: null, shapes: null, keep: null, refs: null, ...fields },
        ...(answersPending === undefined ? {} : { answers_pending: answersPending }),
      }),
    );
    setProvider(provider);
    const registry = new AgentRegistry();
    registry.register(
      buildFixtureCard({
        id: 'fixture-a',
        required: [{ name: 'goal' }, { name: 'shapes', delegable: true }, { name: 'keep', delegable: true }, { name: 'refs' }],
      }),
      fixtureEchoHandler,
      undefined,
    );
    return { provider, adapter: new ChatInputAdapter(buildFakeCore(), registry) };
  }

  const extract = (adapter: ChatInputAdapter, userMessage: string) =>
    adapter.extract({ conversationId, userMessage, priorDecision: asked, llmContext: ctx });

  it('declares answers_pending in the tool schema the model is forced into', async () => {
    const { provider, adapter } = setup({}, false);
    await extract(adapter, 'hola');
    const params = provider.captured[0].params as { tools: Array<{ function: { parameters: { required: string[]; properties: Record<string, unknown> } } }> };
    const schema = params.tools[0].function.parameters;
    expect(schema.required).toEqual(['fields', 'answers_pending']);
    expect(schema.properties.answers_pending).toEqual({ type: 'boolean' });
  });

  it('when the reply answers the questions, asked delegable fields left empty get the delegated value at 1.0; asked non-delegable ones stay empty', async () => {
    const { adapter } = setup({ goal: { value: 'Verse profesional', confidence: 0.95 } }, true);
    const delta = await extract(adapter, 'Quiero verme profesional');
    expect(delta.fields['fixture-a']).toEqual({
      goal: { value: 'Verse profesional', confidence: 0.95 },
      shapes: { value: DELEGATED_FIELD_VALUE, confidence: 1 },
      keep: { value: DELEGATED_FIELD_VALUE, confidence: 1 },
    });
    expect(delta.fields['fixture-a']?.refs).toBeUndefined();
  });

  it('a conversation pinned to extractor.v7 (no answers_pending in its schema) still extracts, without delegating', async () => {
    const { provider, adapter } = setup({ goal: { value: 'Verse profesional', confidence: 0.95 } }, undefined);
    const delta = await adapter.extract({ conversationId, userMessage: 'hola', priorDecision: asked, llmContext: ctx, promptVersions: { extractor: 'extractor.v7' } });
    const params = provider.captured[0].params as { tools: Array<{ function: { parameters: { properties: Record<string, unknown> } } }> };
    expect(params.tools[0].function.parameters.properties.answers_pending).toBeUndefined();
    expect(delta.fields['fixture-a']).toEqual({ goal: { value: 'Verse profesional', confidence: 0.95 } });
  });

  it('does not delegate when the reply does not answer the questions (or the flag is missing)', async () => {
    for (const flag of [false, undefined]) {
      const { adapter } = setup({}, flag);
      const delta = await extract(adapter, '¿Qué es un monograma?');
      expect(delta.fields).toEqual({});
    }
  });

  it('normalizes «Sin preferencia» / «No aplica» on a delegable field; a non-delegable «No aplica» is kept', async () => {
    const { adapter } = setup(
      { shapes: { value: 'Sin preferencia', confidence: 1 }, keep: { value: 'No aplica', confidence: 1 }, refs: { value: 'No aplica', confidence: 1 } },
      false,
    );
    const delta = await extract(adapter, 'forma: no sé, conservar: nada, referencias: ninguna');
    expect(delta.fields['fixture-a']).toEqual({
      shapes: { value: DELEGATED_FIELD_VALUE, confidence: 1 },
      keep: { value: DELEGATED_FIELD_VALUE, confidence: 1 },
      refs: { value: 'No aplica', confidence: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// D35: grouped confirmation
// ---------------------------------------------------------------------------

describe('ChatInputAdapter — grouped confirm_fields (D35)', () => {
  beforeEach(() => {
    recordSpy.mockClear();
  });
  afterEach(() => {
    resetProvider();
  });

  const grouped: ConfirmFieldsDecision = {
    kind: 'confirm_fields',
    entries: [
      { agentId: 'fixture-a', fieldName: 'business_name', pendingValue: 'Dulce Hogar' },
      { agentId: 'fixture-a', fieldName: 'style_keywords', pendingValue: 'elegante' },
    ],
    reason: 'low_confidence',
  };

  async function turn(userMessage: string, llmFields: Record<string, ToolField> = {}, mutate?: (store: InMemoryConversationStore) => Promise<void>) {
    const provider = makeExtractorProvider(
      JSON.stringify({ fields: { business_name: null, style_keywords: null, ...llmFields } }),
    );
    setProvider(provider);
    const registry = new AgentRegistry();
    registry.register(
      buildFixtureCard({ id: 'fixture-a', required: [{ name: 'business_name' }, { name: 'style_keywords' }] }),
      fixtureEchoHandler,
      undefined,
    );
    const store = new InMemoryConversationStore(registry.getFieldSchemas());
    await store.getOrCreate(conversationId, TEST_TENANT_ID, TEST_USER_ID);
    for (const e of grouped.entries) {
      await store.updateFieldSlot(conversationId, 'fixture-a', e.fieldName, true, { status: 'pending_confirmation', value: e.pendingValue, confidence: 0.7 });
    }
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);
    const delta = await adapter.extract({ conversationId, userMessage, priorDecision: grouped, llmContext: ctx });
    await mutate?.(store);
    await mergeFieldDelta(delta, store, registry);
    const state = (await store.get(conversationId))!.agentStates['fixture-a'].requiredFields;
    return { delta, state };
  }

  it('a bare «sí» confirms every pending value in one turn, without calling the LLM', async () => {
    const { delta, state } = await turn('sí');
    expect(recordSpy).not.toHaveBeenCalled();
    expect(Object.keys(delta.fields['fixture-a'] ?? {}).sort()).toEqual(['business_name', 'style_keywords']);
    expect(state.business_name).toMatchObject({ status: 'filled', value: 'Dulce Hogar', confidence: 1 });
    expect(state.style_keywords).toMatchObject({ status: 'filled', value: 'elegante', confidence: 1 });
  });

  it('a bare «no» resets all of them', async () => {
    const { delta, state } = await turn('no');
    expect(recordSpy).not.toHaveBeenCalled();
    expect(delta.intents).toHaveLength(2);
    expect(state.business_name.status).toBe('empty');
    expect(state.style_keywords.status).toBe('empty');
  });

  it('a compound «sí» applies the correction it restates and confirms the rest', async () => {
    const { state } = await turn('Sí, pero el estilo es rústico', { style_keywords: { value: 'rústico', confidence: 0.95 } });
    expect(state.business_name).toMatchObject({ status: 'filled', value: 'Dulce Hogar' });
    expect(state.style_keywords).toMatchObject({ status: 'filled', value: 'rústico' });
  });

  it('a compound «no» resets what it does not restate and replaces what it does', async () => {
    const { state } = await turn('No, se llama Dulce Casa', { business_name: { value: 'Dulce Casa', confidence: 0.95 } });
    expect(state.business_name).toMatchObject({ status: 'filled', value: 'Dulce Casa' });
    expect(state.style_keywords.status).toBe('empty');
  });

  it('a stale «sí» (the value changed meanwhile) does not overwrite that entry; the others still confirm', async () => {
    const { state } = await turn('sí', {}, (store) =>
      store.updateFieldSlot(conversationId, 'fixture-a', 'business_name', true, { status: 'filled', value: 'Otro Nombre', confidence: 1 }),
    );
    expect(state.business_name).toMatchObject({ status: 'filled', value: 'Otro Nombre' });
    expect(state.style_keywords).toMatchObject({ status: 'filled', value: 'elegante', confidence: 1 });
  });
});

describe('ChatInputAdapter: enum fields map free text to the dictionary (D41)', () => {
  beforeEach(() => {
    recordSpy.mockClear();
  });
  afterEach(() => {
    resetProvider();
  });

  async function extractCategory(args: unknown) {
    const provider = makeExtractorProvider(JSON.stringify(args));
    setProvider(provider);
    const registry = new AgentRegistry();
    registry.register(buildFixtureCard({ id: 'fixture-a', required: [{ name: 'business_category' }] }), fixtureEchoHandler, undefined);
    const store = new InMemoryConversationStore(registry.getFieldSchemas());
    await store.getOrCreate(conversationId, TEST_TENANT_ID, TEST_USER_ID);
    const adapter = new ChatInputAdapter(buildFakeCore(), registry);
    const delta = await adapter.extract({ conversationId, userMessage: 'vendo pan y tortas', llmContext: ctx });
    await mergeFieldDelta(delta, store, registry);
    const snapshot = await store.get(conversationId);
    return { delta, provider, slot: snapshot!.agentStates['fixture-a'].requiredFields.business_category };
  }

  it('sends the dictionary codes as the category enum of the tool schema', async () => {
    const { provider } = await extractCategory({ fields: { business_category: null }, answers_pending: false });
    const schema = JSON.stringify(provider.create.mock.calls[0]);
    expect(schema).toContain('PANADERIA_Y_PASTELERIA');
    expect(schema).toContain('OTRO');
  });

  it('keeps the raw text as the value and carries the category into the slot', async () => {
    const { slot } = await extractCategory({
      fields: { business_category: { value: 'vendo pan y tortas', confidence: 0.95, category: 'PANADERIA_Y_PASTELERIA' } },
      answers_pending: false,
    });
    expect(slot).toMatchObject({ status: 'filled', value: 'vendo pan y tortas', category: 'PANADERIA_Y_PASTELERIA' });
  });

  it('a category outside the list fails the parse instead of storing garbage', async () => {
    const { delta } = await extractCategory({
      fields: { business_category: { value: 'vendo pan', confidence: 0.95, category: 'INVENTADA' } },
      answers_pending: false,
    });
    expect(delta.fields).toEqual({});
  });
});
