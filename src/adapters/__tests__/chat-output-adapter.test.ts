/**
 * Unit tests for ChatOutputAdapter. One case per PlannerDecision kind.
 *
 * The adapter calls Gemini Pro through the LLM provider; we inject a fake
 * provider that captures the prompt and returns scripted Spanish content.
 * Mocks the repos factory so withLlmLogging never touches the DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordSpy = vi.fn(async () => 'fake-llm-call-id');
vi.mock('../../repos', () => ({
  repos: () => ({ llmCalls: { record: recordSpy } }),
  systemRepos: () => ({ llmCalls: { record: recordSpy } }),
}));

import { ChatOutputAdapter, GENERIC_FALLBACK_REPLY, MAX_REPLY_CHARS, unusableReplyReason } from '../chat-output-adapter';
import {
  buildAgentRequirementState,
  buildSingleAgentFixtureRegistry,
  buildSnapshot,
  FakeLLMProvider,
  TEST_CONVERSATION_ID,
  TEST_TENANT_ID,
  TEST_USER_ID,
} from '../../core/__tests__/_fixtures';
import { resetProvider, setProvider } from '../../services/llm';
import type { PlannerDecision } from '../../core/contracts';
import { createCurrentAdapterBehaviorSnapshot } from '../../services/ai-config/adapter-behavior';

const conversationId = TEST_CONVERSATION_ID;
const tenantId = TEST_TENANT_ID;

const ctx = {
  tenant: { id: tenantId },
  user: { id: TEST_USER_ID },
  conversationId,
  promptVersion: 'responder.chat-step1.v1',
};

const emptySnapshot = buildSnapshot({
  agentStates: {
    'test-fixture-agent': buildAgentRequirementState(),
  },
});

const filledSnapshot = buildSnapshot({
  agentStates: {
    'test-fixture-agent': buildAgentRequirementState({
      requiredFields: {
        business_name: { status: 'filled', value: 'Café Andino', confidence: 1 },
        business_profile: {
          status: 'filled',
          value: 'café orgánico de Cajamarca',
          confidence: 1,
        },
      },
      iterationCount: 1,
    }),
  },
});

function makeResponderProvider(scriptedReply: string): FakeLLMProvider {
  return new FakeLLMProvider({
    purpose: 'responder',
    modelId: 'google/gemini-2.5-pro',
  }).scriptContent(scriptedReply);
}

describe('ChatOutputAdapter', () => {
  let provider: FakeLLMProvider;

  beforeEach(() => {
    recordSpy.mockClear();
  });
  afterEach(() => {
    resetProvider();
  });

  it('keeps persona + guardrails as a stable prefix across turns (prompt caching)', async () => {
    const registry = buildSingleAgentFixtureRegistry().registry;
    const render = async (decisions: ReadonlyArray<PlannerDecision>) => {
      setProvider(provider = makeResponderProvider('ok'));
      await new ChatOutputAdapter(registry).render({ decisions, recentMessages: [{ role: 'user', content: 'hola' }], snapshot: filledSnapshot, llmContext: ctx });
      return provider.captured[0];
    };
    const ask = (fieldName: string): PlannerDecision => ({ kind: 'request_fields', agentId: 'test-fixture-agent', fields: [{ fieldName, promptHint: 'h' }] });
    const ca = await render([ask('business_name')]);
    const cb = await render([{ kind: 'announce_dispatch', agentId: 'test-fixture-agent' } as PlannerDecision, ask('business_profile')]);
    // Two system messages: the static part is byte-identical across turns, the tail is per-turn.
    expect(ca.systemParts).toHaveLength(2);
    expect(ca.systemParts[0]).toBe(cb.systemParts[0]);
    expect(ca.systemParts[1]).not.toBe(cb.systemParts[1]);
    expect(ca.systemParts[1]).toMatch(/^\n\nEstado actual del orquestador/);
    const a = ca.systemPrompt;
    const b = cb.systemPrompt;
    const prefixEnd = a.indexOf('Estado actual del orquestador');
    expect(prefixEnd).toBeGreaterThan(0);
    expect(a.slice(0, prefixEnd)).toBe(b.slice(0, prefixEnd));
    // Per-turn dispatch guardrail lands after the state, never inside the static prefix.
    expect(b.indexOf('Cuando combines un anuncio de despacho')).toBeGreaterThan(prefixEnd);
    expect(a).not.toContain('Cuando combines un anuncio de despacho');
  });

  it('renders request_fields with both field names in one ask, no leaked user values', async () => {
    setProvider(provider = makeResponderProvider('¿Cómo se llama tu negocio y qué estilo buscas?'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [
      {
        kind: 'request_fields',
        agentId: 'test-fixture-agent',
        fields: [
          { fieldName: 'business_name', promptHint: '¿Cómo se llama tu negocio?' },
          { fieldName: 'business_profile', promptHint: '¿Qué hace tu negocio?' },
        ],
      },
    ];
    const { content } = await adapter.render({
      decisions,
      recentMessages: [{ role: 'user', content: 'hola' }],
      snapshot: filledSnapshot,
      llmContext: ctx,
    });

    expect(content.length).toBeGreaterThan(0);
    expect(provider.captured[0].systemPrompt).toContain('business_name');
    expect(provider.captured[0].systemPrompt).toContain('business_profile');
    expect(provider.captured[0].systemPrompt).toContain('request_fields');
    // The two-field branch tells the responder to ask both in one sentence.
    expect(provider.captured[0].systemPrompt).toContain('AMBOS campos en UNA sola oración');
    // Status-only summary: filled, but the actual value must not appear.
    expect(provider.captured[0].systemPrompt).toContain('filled');
    expect(provider.captured[0].systemPrompt).not.toContain('Café Andino');
    expect(provider.captured[0].systemPrompt).not.toContain('café orgánico de Cajamarca');
  });

  it.each([
    ['the active release', undefined],
    ['a release pinned before v7 (fragment fallback)', { responder: 'responder.chat-step1.v6' }],
  ])('asks more than 2 fields as ONE numbered list in decision order, never the raw name (%s)', async (_label, promptVersions) => {
    setProvider(provider = makeResponderProvider('ok'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);
    await adapter.render({
      decisions: [{
        kind: 'request_fields',
        agentId: 'test-fixture-agent',
        fields: [
          { fieldName: 'logo_goal', promptHint: 'Hint goal' },
          { fieldName: 'competitors', promptHint: 'Hint competitors' },
          { fieldName: 'logo_keep', promptHint: 'Hint keep' },
        ],
      }],
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
      promptVersions,
    });
    const prompt = provider.captured[0].systemPrompt;
    expect(prompt).toContain('  1. logo_goal: "Hint goal"\n  2. competitors: "Hint competitors"\n  3. logo_keep: "Hint keep"');
    expect(prompt).toContain('agrupe los campos de arriba por afinidad');
    expect(prompt).toContain('NO numeres');
    expect(prompt).not.toMatch(/no aplica|sin preferencia|lista numerada/i);
    expect(prompt).not.toContain('AMBOS campos');
    expect(prompt).not.toContain('undefined');
  });

  it('renders a single-field request_fields with the singular instruction', async () => {
    setProvider(provider = makeResponderProvider('¿Cómo se llama tu negocio?'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [
      {
        kind: 'request_fields',
        agentId: 'test-fixture-agent',
        fields: [
          { fieldName: 'business_name', promptHint: '¿Cómo se llama tu negocio?' },
        ],
      },
    ];
    await adapter.render({
      decisions,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(provider.captured[0].systemPrompt).toContain('UNA sola pregunta natural');
    expect(provider.captured[0].systemPrompt).toContain('business_name');
  });

  it('does not leak previousValue on a re-asked field after reset', async () => {
    setProvider(provider = makeResponderProvider('¿Me cuentas otra vez el nombre del negocio?'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [
      {
        kind: 'request_fields',
        agentId: 'test-fixture-agent',
        fields: [
          {
            fieldName: 'business_name',
            promptHint: '¿Cómo se llama tu negocio?',
            previousValue: 'Café Andino',
          },
        ],
      },
    ];
    await adapter.render({
      decisions,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(provider.captured[0].systemPrompt).not.toContain('Café Andino');
  });

  it('renders confirm_fields with every pending value in the prompt (D35)', async () => {
    setProvider(provider = makeResponderProvider('¿Confirmas que tu negocio se llama "Café Andino"?'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [
      {
        kind: 'confirm_fields',
        entries: [
          { agentId: 'test-fixture-agent', fieldName: 'business_name', pendingValue: 'Café Andino' },
          { agentId: 'test-fixture-agent', fieldName: 'tone', pendingValue: 'cálido' },
        ],
        reason: 'low_confidence',
      },
    ];
    const { content } = await adapter.render({
      decisions,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(content).toContain('Café Andino');
    expect(provider.captured[0].systemPrompt).toContain('Café Andino');
    const prompt = provider.captured[0].systemPrompt;
    expect(prompt).toContain('kind=confirm_fields');
    expect(prompt).toContain('business_name: "Café Andino"');
    expect(prompt).toContain('tone: "cálido"');
    expect(prompt).toContain('UNA sola pregunta cerrada');
  });

  it('v12 guardrails: never claims something was saved, never asks about a field outside the decision (D35)', async () => {
    setProvider(provider = makeResponderProvider('ok'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);
    await adapter.render({ decisions: [{ kind: 'announce_all_complete' }], recentMessages: [], snapshot: emptySnapshot, llmContext: ctx });
    const prompt = provider.captured[0].systemPrompt;
    expect(prompt).toContain('NUNCA afirmes que algo "ya quedó registrado"');
    expect(prompt).toContain('NUNCA preguntes por un campo o tema que no esté en la decisión actual');
  });

  it('a conversation pinned to v11 still renders confirm_fields through the fragment fallback', async () => {
    setProvider(provider = makeResponderProvider('ok'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);
    await adapter.render({
      decisions: [{ kind: 'confirm_fields', entries: [{ agentId: 'test-fixture-agent', fieldName: 'tone', pendingValue: 'cálido' }], reason: 'low_confidence' }],
      recentMessages: [], snapshot: emptySnapshot, llmContext: ctx,
      promptVersions: { responder: 'responder.chat-step1.v12' },
    });
    expect(provider.captured[0].systemPrompt).toContain('tone: "cálido"');
  });

  it('renders announce_dispatch with explicit bans on greetings and waiting filler', async () => {
    setProvider(provider = makeResponderProvider('Empecé el diseño; aparecerá en el panel.'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [
      {
        kind: 'announce_dispatch',
        agentId: 'test-fixture-agent',
        taskId: '11111111-1111-1111-1111-111111111111',
      },
    ];
    const { content } = await adapter.render({
      decisions,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(content.length).toBeGreaterThan(0);
    expect(provider.captured[0].systemPrompt).toContain('announce_dispatch');
    expect(provider.captured[0].systemPrompt).toContain('PROHIBIDO usar "estoy trabajando"');
    expect(provider.captured[0].systemPrompt).toContain('PROHIBIDO usar saludos');
  });

  it('bundles announce_dispatch with request_fields and instructs a single bridged reply', async () => {
    setProvider(
      provider = makeResponderProvider('Ya estoy generando tu logo. Para el slogan, ¿qué tono buscas?'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [
      {
        kind: 'announce_dispatch',
        agentId: 'logo-agent',
        taskId: '11111111-1111-1111-1111-111111111111',
      },
      {
        kind: 'request_fields',
        agentId: 'tagline-agent',
        fields: [{ fieldName: 'tone', promptHint: '¿Qué tono buscas?' }],
      },
    ];
    await adapter.render({
      decisions,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    // Both decision kinds must appear in the prompt as numbered blocks.
    expect(provider.captured[0].systemPrompt).toContain('Decisión 1:');
    expect(provider.captured[0].systemPrompt).toContain('Decisión 2:');
    expect(provider.captured[0].systemPrompt).toContain('announce_dispatch');
    expect(provider.captured[0].systemPrompt).toContain('request_fields');
    // The bundled-bridge guardrail must be appended.
    expect(provider.captured[0].systemPrompt).toContain('combines un anuncio de despacho');
  });

  it('every rendered prompt carries the global no-greetings / no-waiting-filler guardrails', async () => {
    const decisions: ReadonlyArray<PlannerDecision> = [
      {
        kind: 'request_fields',
        agentId: 'test-fixture-agent',
        fields: [{ fieldName: 'business_name', promptHint: 'q' }],
      },
      {
        kind: 'confirm_fields',
        entries: [{ agentId: 'test-fixture-agent', fieldName: 'business_name', pendingValue: 'X' }],
        reason: 'low_confidence',
      },
      {
        kind: 'announce_dispatch',
        agentId: 'test-fixture-agent',
        taskId: '11111111-1111-1111-1111-111111111111',
      },
      {
        kind: 'announce_completion',
        agentId: 'test-fixture-agent',
        taskId: '11111111-1111-1111-1111-111111111111',
        deliverableIds: [],
        artifacts: [],
      },
      { kind: 'announce_all_complete' },
    ];
    for (const decision of decisions) {
      setProvider(provider = makeResponderProvider('ok'));
      const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);
      await adapter.render({
        decisions: [decision],
        recentMessages: [],
        snapshot: emptySnapshot,
        llmContext: ctx,
      });
      expect(provider.captured[0].systemPrompt, `kind=${decision.kind}`).toContain('NO uses saludos');
      expect(provider.captured[0].systemPrompt, `kind=${decision.kind}`).toContain('NO uses muletillas de espera');
    }
  });

  it('renders announce_completion (image artifact only) without leaking snapshot values', async () => {
    setProvider(
      provider = makeResponderProvider('Tu logo está en el panel lateral. Sigamos con el siguiente paso.'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [
      {
        kind: 'announce_completion',
        agentId: 'test-fixture-agent',
        taskId: '11111111-1111-1111-1111-111111111111',
        deliverableIds: [],
        artifacts: [
          { kind: 'image', url: 'https://example.test/logo.png', metadata: {} },
        ],
      },
    ];
    await adapter.render({
      decisions,
      recentMessages: [],
      snapshot: filledSnapshot,
      llmContext: ctx,
    });

    expect(provider.captured[0].systemPrompt).toContain('announce_completion');
    expect(provider.captured[0].systemPrompt).toContain('business_name');
    expect(provider.captured[0].systemPrompt).not.toContain('Café Andino');
    expect(provider.captured[0].systemPrompt).not.toContain('café orgánico de Cajamarca');
    expect(provider.captured[0].systemPrompt).toContain('panel lateral');
  });

  it('renders announce_completion with text artifacts as a numbered list of options', async () => {
    setProvider(
      provider = makeResponderProvider('Aquí tienes tres opciones: 1. Sazón Andino, 2. Sabor del Norte, 3. Andes Café. ¿Cuál prefieres?'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [
      {
        kind: 'announce_completion',
        agentId: 'test-fixture-agent',
        taskId: '11111111-1111-1111-1111-111111111111',
        deliverableIds: [],
        artifacts: [
          { kind: 'text', inline: 'Sazón Andino' },
          { kind: 'text', inline: 'Sabor del Norte' },
          { kind: 'text', inline: 'Andes Café' },
        ],
      },
    ];
    const { content } = await adapter.render({
      decisions,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(provider.captured[0].systemPrompt).toContain('Sazón Andino');
    expect(provider.captured[0].systemPrompt).toContain('Sabor del Norte');
    expect(provider.captured[0].systemPrompt).toContain('Andes Café');
    expect(provider.captured[0].systemPrompt).toContain('1. Sazón Andino');
    expect(provider.captured[0].systemPrompt).toContain('2. Sabor del Norte');
    expect(provider.captured[0].systemPrompt).toContain('3. Andes Café');
    expect(content).toContain('Sazón Andino');
  });

  it('renders announce_all_complete as a step-finished message', async () => {
    setProvider(provider = makeResponderProvider('Hemos terminado este paso, sigamos.'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [{ kind: 'announce_all_complete' }];
    const { content } = await adapter.render({
      decisions,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(content.length).toBeGreaterThan(0);
    expect(provider.captured[0].systemPrompt).toContain('announce_all_complete');
  });

  it('forwards the last user/assistant turns as conversation context', async () => {
    setProvider(provider = makeResponderProvider('ok'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    const decisions: ReadonlyArray<PlannerDecision> = [{ kind: 'announce_all_complete' }];
    await adapter.render({
      decisions,
      recentMessages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'hola, cuéntame de tu negocio' },
        { role: 'system', content: 'should be filtered out' } as any,
      ],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    // 2 system (static + per-turn) + 2 chat turns; the system row from recentMessages is dropped.
    expect(provider.captured[0].messageCount).toBe(4);
  });

  it('takes the prompt from the frozen file and the model/settings from the execution (D22)', async () => {
    const provider = makeResponderProvider('ok');
    const behavior = createCurrentAdapterBehaviorSnapshot();
    const frozen = { ...behavior, responder: { ...behavior.responder, promptTemplate: 'ignored: the manifest no longer supplies the prompt', temperature: 0.7 } };
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    await adapter.render({
      decisions: [{ kind: 'announce_all_complete' }],
      recentMessages: [{ role: 'user', content: 'must not be included' }],
      snapshot: emptySnapshot,
      llmContext: ctx,
      execution: { model: { ...provider.resolve('responder'), provider: 'anthropic', modelId: 'claude-sonnet-5-5' }, behavior: frozen },
    });

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.captured[0].systemPrompt).not.toContain('ignored');
    expect(provider.captured[0].systemPrompt).toContain('español neutro latinoamericano');
    expect(provider.captured[0].messageCount).toBe(3);
    expect((provider.create.mock.calls[0][0] as any).temperature).toBe(0.7);
    // KAN-69 A6: the llm_calls row carries the execution's effective provenance.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect((recordSpy.mock.calls[0] as any[])[0]).toMatchObject({
      provider: 'anthropic',
      purpose: 'responder',
      model: 'claude-sonnet-5-5',
      inputTokens: 50,
      outputTokens: 30,
    });
  });

  it('renders offer_generation as a pointer to the Generar button, never as «generating»', async () => {
    setProvider(provider = makeResponderProvider('Ya tienes todo listo para tu logo. Cuando quieras, toca el botón Generar.'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    await adapter.render({
      decisions: [{ kind: 'offer_generation', agentId: 'test-fixture-agent', deliverableKind: 'logo' }],
      recentMessages: [],
      snapshot: filledSnapshot,
      llmContext: ctx,
    });

    const prompt = provider.captured[0].systemPrompt;
    expect(prompt).toContain('offer_generation');
    expect(prompt).toContain('botón Generar');
    expect(prompt).toContain('PROHIBIDO decir que ya empezaste a generar');
    expect(prompt).not.toContain('Café Andino');
  });

  it('every prompt guides chat change requests to the panel buttons (KAN-28)', async () => {
    setProvider(provider = makeResponderProvider('ok'));
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);
    await adapter.render({
      decisions: [{ kind: 'announce_all_complete' }],
      recentMessages: [{ role: 'user', content: 'cámbiale el color al logo' }],
      snapshot: filledSnapshot,
      llmContext: ctx,
    });
    const prompt = provider.captured[0].systemPrompt;
    expect(prompt).toContain('Para ajustar este logo, toca el botón Iterar y escribe qué quieres cambiar.');
    expect(prompt).toContain('nunca digas que ya generaste');
    expect(prompt).toContain('español neutro latinoamericano');
  });

  it('bumps the responder prompt version for the command guidance', () => {
    expect(createCurrentAdapterBehaviorSnapshot().responder.promptVersion).toBe('responder.chat-step1.v15');
  });

  it('a release frozen before v6 still renders offer_generation through the fragment fallbacks', async () => {
    setProvider(provider = makeResponderProvider('ok'));
    const behavior = createCurrentAdapterBehaviorSnapshot();
    const {
      offerGenerationDecision: _offer,
      commandGuidanceGuardrail: _guidance,
      ...olderFragments
    } = behavior.responder.promptFragments;
    const frozen = { ...behavior, responder: { ...behavior.responder, promptFragments: olderFragments } };
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    await adapter.render({
      decisions: [{ kind: 'offer_generation', agentId: 'test-fixture-agent', deliverableKind: 'logo' }],
      recentMessages: [],
      snapshot: filledSnapshot,
      llmContext: ctx,
      execution: { model: { ...provider.resolve('responder'), provider: 'openrouter' }, behavior: frozen },
    });

    const prompt = provider.captured[0].systemPrompt;
    expect(prompt).toContain('botón Generar');
    expect(prompt).not.toContain('undefined');
  });

  it('uses the active frozen version without an execution, and the pinned one when given (D22)', async () => {
    const provider = makeResponderProvider('ok');
    setProvider(provider);
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);
    const base = { decisions: [{ kind: 'announce_all_complete' as const }], recentMessages: [], snapshot: emptySnapshot, llmContext: ctx };

    await adapter.render(base);
    await adapter.render({ ...base, promptVersions: { responder: 'responder.chat-step1.v6' } });
    expect(recordSpy.mock.calls.map((call) => (call as any[])[0].promptVersion)).toEqual(['responder.chat-step1.v15', 'responder.chat-step1.v6']);
  });

  it('falls back to the active version when the pinned one no longer exists', async () => {
    const provider = makeResponderProvider('ok');
    setProvider(provider);
    const adapter = new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry);

    await adapter.render({
      decisions: [{ kind: 'announce_all_complete' }], recentMessages: [], snapshot: emptySnapshot, llmContext: ctx,
      promptVersions: { responder: 'responder.chat-step1.v0' },
    });
    expect((recordSpy.mock.calls[0] as any[])[0].promptVersion).toBe('responder.chat-step1.v15');
  });

  describe('KAN-93 conversation context', () => {
    const run = async (context: unknown, frozen?: boolean) => {
      setProvider(provider = makeResponderProvider('ok'));
      let execution;
      if (frozen) {
        const behavior = createCurrentAdapterBehaviorSnapshot();
        const { personaContextual: _a, brandChatContext: _b, productChatContext: _c, ...older } = behavior.responder.promptFragments;
        execution = { model: { ...provider.resolve('responder'), provider: 'openrouter' as const }, behavior: { ...behavior, responder: { ...behavior.responder, promptFragments: older } } };
      }
      await new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry).render({
        decisions: [{ kind: 'announce_all_complete' }], recentMessages: [], snapshot: emptySnapshot, llmContext: ctx, context: context as never, execution,
      });
      return provider.captured[0].systemPrompt as string;
    };
    const brand = { brandId: 'b1', brandName: 'Brisa Ron', productId: null, productName: null };

    it('adds the brand chat line, and the contextual persona', async () => {
      const prompt = await run(brand);
      expect(prompt).toContain('Conversación: chat de la marca "Brisa Ron".');
      expect(prompt).toContain('trabajan en su marca y en sus productos');
      expect(prompt).not.toContain('paso a paso');
    });
    it('adds the product chat line', async () => {
      expect(await run({ ...brand, productId: 'p1', productName: 'Ron añejo' })).toContain('Conversación: chat del producto "Ron añejo" de la marca "Brisa Ron".');
    });
    it('adds no context line for a legacy conversation', async () => {
      expect(await run({ brandId: null, brandName: null, productId: null, productName: null })).not.toContain('Conversación:');
      expect(await run(undefined)).not.toContain('Conversación:');
    });
    it('an older frozen release still gets the new fragments through the fallbacks', async () => {
      const prompt = await run(brand, true);
      expect(prompt).toContain('Conversación: chat de la marca "Brisa Ron".');
      expect(prompt).not.toContain('undefined');
    });
  });

  describe('KAN-91 dead-end fixes', () => {
    const renderPrompt = async (decision: PlannerDecision, snapshot = emptySnapshot, promptVersions?: never) => {
      setProvider(provider = makeResponderProvider('ok'));
      await new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry).render({
        decisions: [decision], recentMessages: [], snapshot, llmContext: ctx, promptVersions,
      });
      return provider.captured[0].systemPrompt as string;
    };
    const status = (state: 'generating' | 'in_review' | 'failed', allowedCommands: ReadonlyArray<'approve' | 'iterate' | 'retry' | 'cancel'>): PlannerDecision =>
      ({ kind: 'report_deliverable_status', agentId: 'test-fixture-agent', deliverableKind: 'logo', state, allowedCommands });

    it('renders each state with the label and only the allowed button names', async () => {
      const review = await renderPrompt(status('in_review', ['approve', 'iterate']));
      expect(review).toContain('kind=report_deliverable_status');
      expect(review).toContain('Botones del panel disponibles ahora: Aprobar, Iterar');
      const failed = await renderPrompt(status('failed', ['retry']));
      expect(failed).toContain('algo salió mal');
      expect(failed).toContain('Botones del panel disponibles ahora: Reintentar');
      expect(failed).not.toContain('disponibles ahora: Reintentar, Iterar');
      expect(await renderPrompt(status('generating', ['cancel']))).toContain('se está generando');
    });

    it('renders exhausted (D39) with scope, counts and label', async () => {
      const alterations = await renderPrompt({ kind: 'exhausted', scope: 'alterations', agentId: 'test-fixture-agent', deliverableKind: 'logo', limit: 3, used: 3 });
      expect(alterations).toContain('kind=exhausted');
      expect(alterations).toContain('ámbito: alterations; usados 3 de 3');
      expect(await renderPrompt({ kind: 'exhausted', scope: 'turns', limit: 40, used: 40 })).toContain('ámbito: turns; usados 40 de 40');
    });

    it('picks the brand or product fragment for announce_all_complete by links.hasProduct', async () => {
      const brand = await renderPrompt({ kind: 'announce_all_complete' });
      expect(brand).toContain('«Nuevo producto»');
      const product = await renderPrompt({ kind: 'announce_all_complete' }, buildSnapshot({ links: { hasBrand: true, hasProduct: true } }));
      expect(product).toContain('etiqueta');
      expect(product).not.toContain('«Nuevo producto» NO');
    });

    it('KAN-110: request_fields with uploads asks both in one prompt', async () => {
      const prompt = await renderPrompt({
        kind: 'request_fields', agentId: 'test-fixture-agent',
        fields: [{ fieldName: 'ad_brief', promptHint: 'la foto' }],
        uploads: [{ agentId: 'test-fixture-agent', deliverableKind: 'label', uploadKind: 'lab_report', promptHint: 'sube el PDF' }],
      });
      expect(prompt).toContain('kind=request_fields');
      expect(prompt).toContain('"la foto"');
      expect(prompt).toContain('Además, en el mismo mensaje:');
      expect(prompt).toContain('"sube el PDF"');
    });

    it('D34: renders request_upload with the card hint, and the product chat redirects brand deliverables', async () => {
      const prompt = await renderPrompt({ kind: 'request_upload', agentId: 'test-fixture-agent', deliverableKind: 'label', uploadKind: 'lab_report', promptHint: 'sube el PDF' });
      expect(prompt).toContain('kind=request_upload');
      expect(prompt).toContain('"sube el PDF"');
      setProvider(provider = makeResponderProvider('ok'));
      await new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry).render({
        decisions: [{ kind: 'announce_all_complete' }], recentMessages: [], snapshot: emptySnapshot, llmContext: ctx,
        context: { brandId: 'b', brandName: 'B', productId: 'p', productName: 'P' } as never,
      });
      expect(provider.captured[0].systemPrompt).toContain('«Ir al chat de la marca»');
    });

    it('always carries the no-dead-end guardrail', async () => {
      expect(await renderPrompt({ kind: 'announce_all_complete' })).toContain('NUNCA preguntes "¿seguimos?"');
    });

    it('an older frozen release without the new keys still renders via fallbacks', async () => {
      const current = createCurrentAdapterBehaviorSnapshot();
      const keys = ['reportStatusInReviewDecision', 'reportStatusFailedDecision', 'reportStatusGeneratingDecision', 'announceAllCompleteBrandDecision', 'announceAllCompleteProductDecision', 'noDeadEndGuardrail', 'announceCompletionEmptyNoNextDecision'];
      const old = structuredClone(current);
      for (const k of keys) delete (old.responder.promptFragments as Record<string, string>)[k];
      setProvider(provider = makeResponderProvider('ok'));
      await new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry).render({
        decisions: [status('in_review', ['approve', 'iterate'])], recentMessages: [], snapshot: emptySnapshot, llmContext: ctx,
        execution: { model: { ...provider.resolve('responder'), provider: 'openrouter' }, behavior: old },
      });
      const prompt = provider.captured[0].systemPrompt as string;
      expect(prompt).toContain('Aprobar, Iterar');
      expect(prompt).toContain('NUNCA preguntes "¿seguimos?"');
    });
  });

  describe('output guard', () => {
    const askName: PlannerDecision = {
      kind: 'request_fields',
      agentId: 'test-fixture-agent',
      fields: [{ fieldName: 'business_name', promptHint: '¿Cómo se llama tu negocio?' }],
    };
    const renderWith = (reply: string, decisions: ReadonlyArray<PlannerDecision>) => {
      setProvider(makeResponderProvider(reply));
      return new ChatOutputAdapter(buildSingleAgentFixtureRegistry().registry).render({
        decisions, recentMessages: [], snapshot: emptySnapshot, llmContext: ctx,
      });
    };

    it.each([
      ['empty', '   '],
      ['special_tokens', 'hola <｜begin▁of▁file｜> x'],
      ['prompt_leak', 'Según kind=noop debo invitarte'],
      ['prompt_leak', 'Acción obligatoria: pregunta'],
      ['too_long', 'a'.repeat(MAX_REPLY_CHARS + 1)],
    ])('flags %s', (reason, text) => {
      expect(unusableReplyReason(text)).toBe(reason);
    });

    it('falls back to the first request_fields promptHint', async () => {
      const out = await renderWith('', [askName]);
      expect(out).toEqual({ content: '¿Cómo se llama tu negocio?', fallback: 'empty' });
    });

    it('falls back to the generic message without request_fields', async () => {
      const out = await renderWith('x <|im_end|>', []);
      expect(out).toEqual({ content: GENERIC_FALLBACK_REPLY, fallback: 'special_tokens' });
    });

    it('passes a normal reply untouched', async () => {
      const out = await renderWith('¿Cómo se llama tu negocio?', [askName]);
      expect(out).toEqual({ content: '¿Cómo se llama tu negocio?' });
    });
  });
});
