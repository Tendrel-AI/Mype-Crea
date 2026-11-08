/**
 * Unit tests for ChatInputAdapter.
 *
 * - The affirmation/denial fast paths must NOT call the LLM, and only a bare
 *   yes/no takes them.
 * - Compound replies to confirm_field (yes/no plus a correction or extra
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
  type ConfirmFieldDecision,
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
// KAN-56: compound replies to confirm_field
// ---------------------------------------------------------------------------

const PENDING_NAME = 'Dulce Hogar';
/** Confidence of the stored pending value: between STORE_AND_CONFIRM and AUTO_ACCEPT. */
const PENDING_CONFIDENCE = 0.7;
const AGENT = 'fixture-a';

const confirmName: ConfirmFieldDecision = {
  kind: 'confirm_field',
  agentId: AGENT,
  fieldName: 'business_name',
  pendingValue: PENDING_NAME,
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
 * One confirm_field turn end to end through the adapter and the real merge:
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

describe('ChatInputAdapter — replies to confirm_field (KAN-56)', () => {
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
