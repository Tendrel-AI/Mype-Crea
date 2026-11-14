/**
 * KAN-26 brief: chat and panel converge on one merge path, provenance is
 * recorded and survives a reload, invalid values never reach the store, and
 * the deliverable gate is the server's verdict in both directions.
 *
 * Uses a real OrchestratorCoreImpl over the default registry (logo-agent)
 * with in-memory stores and a recording transport. The Extractor LLM is a
 * FakeLLMProvider; identity, consent and the pinned-conversation read are
 * mocked at the repos boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => {
  const state: { core: unknown } = { core: null };
  const acceptedVersions = new Set<string>(['terminos-v1']);
  const record = vi.fn(async () => undefined);
  const readPinnedConversation = vi.fn(async () => ({ state: 'pinned' }));
  const repos = vi.fn(() => ({
    writeRejections: { record },
    conversations: { readPinnedConversation, context: vi.fn(async () => undefined) },
    termsAcceptances: { hasAccepted: vi.fn(async (version: string) => acceptedVersions.has(version)) },
    llmCalls: { record: vi.fn(async () => 'fake-llm-call-id') },
    usage: { preflight: vi.fn(async () => ({ allowed: true, reservationId: null })) },
  }));
  return { state, acceptedVersions, repos, record, readPinnedConversation };
});

vi.mock('../../../src/auth/resolve-identity', () => ({
  resolveIdentity: async () => ({
    tenant: { id: '00000000-0000-0000-0000-000000000001' },
    user: { id: '00000000-0000-0000-0000-000000000002' },
  }),
}));
vi.mock('../../../src/repos', () => ({ repos: mocks.repos, systemRepos: mocks.repos }));
vi.mock('../../../src/core/orchestrator/runtime', () => ({ getOrchestrator: () => mocks.state.core }));

import { loadBriefAction, updateBriefFieldAction, type BriefPanelField } from '../brief';
import { deliverableCommandAction } from '../deliverable-command';
import { priorDecisionFrom } from '../prior-decision';
import { InProcessDecisionNotifier, OrchestratorCoreImpl } from '../../../src/core/orchestrator/orchestrator-core';
import { InMemoryConversationStore } from '../../../src/core/orchestrator/in-memory-store';
import { InMemoryDeliverableWorkflowStore } from '../../../src/core/orchestrator/deliverable-workflow';
import { buildDefaultRegistry } from '../../../src/core/orchestrator/bootstrap-registry';
import { ChatInputAdapter } from '../../../src/adapters/chat-input-adapter';
import { newTaskId } from '../../../src/core/ids';
import { resetProvider, setProvider } from '../../../src/services/llm';
import { APPROVED_NAME_ID, FakeLLMProvider, TEST_TENANT_ID, TEST_USER_ID, buildApprovedStore } from '../../../src/core/__tests__/_fixtures';
import type { A2AMessage, IAgentTransport } from '../../../src/core/agent-types';
import type { ConfirmFieldsDecision, ConversationId, DeliverableStateView, PlannerDecision } from '../../../src/core/contracts';
import { createCurrentAdapterBehaviorSnapshot, type AdapterBehaviorSnapshot } from '../../../src/services/ai-config/adapter-behavior';
import { TERMS_REQUIRED_MESSAGE } from '../../../src/consent/terms';
import { BRIEF_CATALOG, DELEGATED_FIELD_VALUE } from '../../../src/core/brief';
import logoCard from '../../../agents/logo-agent/agent-card.json';

/** The logo card's required fields: the whole logo brief the gate waits for. */
const LOGO_REQUIRED: ReadonlyArray<string> = logoCard['mypes:requirements'].required.map((f) => f.name);
/** D35: the required fields the card lets the user leave to the designer; they never block «Generar». */
const LOGO_DELEGABLE: ReadonlyArray<string> = logoCard['mypes:requirements'].required.filter((f) => 'delegable' in f && f.delegable).map((f) => f.name);
const LOGO_BLOCKING: ReadonlyArray<string> = LOGO_REQUIRED.filter((n) => !LOGO_DELEGABLE.includes(n));

const CONVERSATION = '3f1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f' as ConversationId;

function buildRuntime(store = new InMemoryConversationStore(buildDefaultRegistry().getFieldSchemas())) {
  const registry = buildDefaultRegistry();
  const dispatched: A2AMessage[] = [];
  const transport: IAgentTransport = {
    dispatch: async (message) => {
      dispatched.push(message);
      return { taskId: message.taskId };
    },
    getResult: async () => ({ status: 'pending' }),
  };
  const workflow = new InMemoryDeliverableWorkflowStore(undefined, newTaskId);
  const core = new OrchestratorCoreImpl({
    store,
    registry,
    transport,
    notifier: new InProcessDecisionNotifier(),
    newTaskId,
    workflowFor: () => workflow,
    // KAN-35: the logo depends on an approved business name.
    approvalsFor: () => buildApprovedStore({ business_name: APPROVED_NAME_ID }),
  });
  mocks.state.core = core;
  return { core, store, registry, dispatched };
}

/**
 * One chat turn's input side, as app/actions/chat.ts runs it, with a scripted
 * Extractor. `release` stands in for a pinned AI release (frozen behavior);
 * `priorDecision` is the decision the previous assistant turn asked.
 */
async function chatTurn(
  runtime: ReturnType<typeof buildRuntime>,
  userMessage: string,
  fields: Record<string, { value: string; confidence: number }>,
  options: { readonly release?: AdapterBehaviorSnapshot; readonly priorDecision?: PlannerDecision } = {},
) {
  // D22: the extractor always asks the registry's fields, whatever list the release froze.
  const askedFields = BRIEF_CATALOG.map((spec) => spec.name);
  const provider = new FakeLLMProvider({ purpose: 'extractor', modelId: 'google/gemini-2.5-flash' }).scriptToolCall(
    'submit_extracted_fields',
    // The tool schema requires every asked field; absent ones are null.
    JSON.stringify({ fields: { ...Object.fromEntries(askedFields.map((name) => [name, null])), ...fields } }),
  );
  setProvider(provider);
  await runtime.core.startConversation(CONVERSATION, TEST_TENANT_ID, TEST_USER_ID);
  const adapter = new ChatInputAdapter(runtime.core, runtime.registry);
  const delta = await adapter.extract({
    conversationId: CONVERSATION,
    userMessage,
    priorDecision: options.priorDecision,
    llmContext: { tenant: { id: TEST_TENANT_ID }, user: { id: TEST_USER_ID }, conversationId: CONVERSATION, promptVersion: 'extractor.v5' },
    ...(options.release
      ? { execution: { model: { ...provider.resolve('extractor'), provider: 'openrouter' }, behavior: options.release } }
      : {}),
  });
  await runtime.core.applyDelta(delta);
  return provider;
}

/** The confirm_fields the planner currently asks, as the next chat turn would receive it. */
async function currentConfirm(runtime: ReturnType<typeof buildRuntime>): Promise<ConfirmFieldsDecision> {
  const decision = (await runtime.core.peekNextDecision(CONVERSATION)).find((d) => d.kind === 'confirm_fields');
  if (!decision || decision.kind !== 'confirm_fields') throw new Error('no confirm_fields pending');
  return decision;
}

function field(fields: ReadonlyArray<BriefPanelField>, name: string) {
  const found = fields.find((f) => f.name === name);
  if (!found) throw new Error(`no brief field ${name}`);
  return found;
}

async function brief() {
  const result = await loadBriefAction({ conversationId: CONVERSATION });
  if (!result.ok) throw new Error(`load failed: ${result.code}`);
  return result;
}

function logoState(states: ReadonlyArray<DeliverableStateView>) {
  const view = states.find((s) => s.agentId === 'logo-agent');
  if (!view) throw new Error('no logo-agent state');
  return view;
}

async function generate(view: DeliverableStateView) {
  return deliverableCommandAction({
    commandId: randomUUID(),
    conversationId: CONVERSATION,
    agentId: 'logo-agent',
    kind: 'generate',
    expectedState: view.state,
    stateToken: view.stateToken,
  });
}

describe('brief actions (KAN-26)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acceptedVersions.clear();
    mocks.acceptedVersions.add('terminos-v1');
  });
  afterEach(() => resetProvider());

  it('lists every catalog field in order, empty and without a source, for a new conversation', async () => {
    buildRuntime();
    const { fields } = await brief();
    expect(fields.map((f) => f.label)).toEqual(BRIEF_CATALOG.map((f) => f.label));
    expect(fields.every((f) => f.status === 'empty' && f.value === null && f.source === null)).toBe(true);
  });

  it('panel channel: a normalized value is filled at once and attributed to the panel', async () => {
    const runtime = buildRuntime();
    const result = await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'location', value: '  Cusco\nsur  andino ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(field(result.fields, 'location')).toMatchObject({ status: 'filled', value: 'Cusco sur andino', source: 'panel' });
    const snapshot = await runtime.core.getSnapshot(CONVERSATION);
    expect(snapshot.agentStates['logo-agent'].optionalFields.location).toMatchObject({ source: 'brief-panel', confidence: 1 });
  });

  it('chat channel: an extracted value reaches the same brief, attributed to the chat', async () => {
    const runtime = buildRuntime();
    await chatTurn(runtime, 'Mi negocio se llama Dulce Andino y fabricamos mermeladas', {
      business_name: { value: 'Dulce Andino', confidence: 0.95 },
      location: { value: 'Cusco', confidence: 0.95 },
    });
    const { fields } = await brief();
    expect(field(fields, 'business_name')).toMatchObject({ status: 'filled', value: 'Dulce Andino', source: 'chat' });
    expect(field(fields, 'location')).toMatchObject({ status: 'filled', value: 'Cusco', source: 'chat' });
  });

  it('an ambiguous chat value waits for confirmation; the panel confirms it through the same operation', async () => {
    const runtime = buildRuntime();
    await chatTurn(runtime, 'creo que el estilo sería algo rústico', { style_keywords: { value: 'rústico', confidence: 0.7 } });
    expect(field((await brief()).fields, 'style_keywords')).toMatchObject({ status: 'pending_confirmation', source: 'chat' });

    const confirmed = await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'style_keywords', value: 'rústico' });
    expect(confirmed.ok && field(confirmed.fields, 'style_keywords')).toMatchObject({ status: 'filled', value: 'rústico', source: 'panel' });
  });

  it('a panel correction replaces a chat value, and both survive a reload', async () => {
    const runtime = buildRuntime();
    await chatTurn(runtime, 'Se llama Dulce Andino', { business_name: { value: 'Dulce Andino', confidence: 0.95 } });
    await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'business_name', value: 'Dulces Andinos' });
    await chatTurn(runtime, 'Usamos frascos de vidrio de 250 g', { location: { value: 'Cusco', confidence: 0.95 } });

    // Reload: a fresh core (new process) over the same persisted store.
    buildRuntime(runtime.store);
    const { fields } = await brief();
    expect(field(fields, 'business_name')).toMatchObject({ status: 'filled', value: 'Dulces Andinos', source: 'panel' });
    expect(field(fields, 'location')).toMatchObject({ status: 'filled', value: 'Cusco', source: 'chat' });
  });

  it.each([
    ['empty value', { fieldName: 'business_name', value: '   ' }, 'invalid_value', 'Escribe un valor para «Nombre del negocio».'],
    ['too long', { fieldName: 'business_name', value: 'a'.repeat(121) }, 'invalid_value', '«Nombre del negocio» puede tener hasta 120 caracteres.'],
    ['non-string value', { fieldName: 'business_name', value: 42 as unknown as string }, 'invalid_value', 'No pudimos validar este dato.'],
    ['unknown field', { fieldName: 'nutrition_facts', value: 'x' }, 'invalid_request', 'No pudimos validar este dato.'],
  ])('refuses %s before any write', async (_name, input, code, message) => {
    const runtime = buildRuntime();
    const result = await updateBriefFieldAction({ conversationId: CONVERSATION, ...input });
    expect(result).toEqual({ ok: false, code, message });
    // KAN-44: only the refusal is logged; the conversation is never read.
    expect(mocks.readPinnedConversation).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledTimes(1);
    await runtime.core.startConversation(CONVERSATION, TEST_TENANT_ID, TEST_USER_ID);
    const snapshot = await runtime.core.getSnapshot(CONVERSATION);
    expect(Object.values(snapshot.agentStates['logo-agent'].requiredFields).every((s) => s.status === 'empty')).toBe(true);
  });

  it('refuses a panel edit without current terms, before touching the conversation', async () => {
    buildRuntime();
    mocks.acceptedVersions.clear();
    const result = await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'business_name', value: 'Dulce Andino' });
    expect(result).toEqual({ ok: false, code: 'terms_required', message: TERMS_REQUIRED_MESSAGE });
  });

  describe('pinned releases captured before KAN-26 (extractor.v4 field list)', () => {
    // The logo fields exactly as the pre-KAN-26 card declared them. Since D22 the release's list is
    // provenance only: the extractor asks the runtime registry's fields.
    const v4Release: AdapterBehaviorSnapshot = (() => {
      const behavior = createCurrentAdapterBehaviorSnapshot([
        { name: 'business_name', required: true, promptHint: '¿Qué nombre debe llevar el logo?', agents: ['logo-agent'] },
        { name: 'color_palette', required: false, promptHint: '¿Tienes colores preferidos para tu marca?', agents: ['logo-agent'] },
        {
          name: 'style_keywords',
          required: true,
          promptHint: 'Describe el estilo del logo (por ejemplo: minimalista, colorido, tradicional).',
          agents: ['logo-agent'],
        },
      ]);
      return { ...behavior, extractor: { ...behavior.extractor, promptVersion: 'extractor.v4' } };
    })();

    it('asks the registry fields (not the stale release list) and still generates', async () => {
      const runtime = buildRuntime();
      const provider = await chatTurn(
        runtime,
        'Se llama Dulce Andino y lo quiero rústico',
        { business_name: { value: 'Dulce Andino', confidence: 0.95 }, style_keywords: { value: 'rústico', confidence: 0.95 } },
        { release: v4Release },
      );

      const request = provider.create.mock.calls[0][0] as { tools: Array<{ function: { parameters: any } }> };
      const asked = Object.keys(request.tools[0].function.parameters.properties.fields.properties).sort();
      expect(asked).toEqual(expect.arrayContaining(['business_name', 'color_palette', 'style_keywords', 'product_name']));
      expect(provider.captured[0].systemPrompt).toContain('product_name');

      const result = await brief();
      expect(field(result.fields, 'business_name')).toMatchObject({ status: 'filled', value: 'Dulce Andino', source: 'chat' });
      // The panel still edits product fields on this conversation (no extractor involved).
      const edited = await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'product_name', value: 'Mermelada' });
      expect(edited.ok && field(edited.fields, 'product_name')).toMatchObject({ value: 'Mermelada', source: 'panel' });

      for (const name of LOGO_REQUIRED.filter((n) => n !== 'business_name' && n !== 'style_keywords')) {
        await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: name, value: 'Sin preferencia' });
      }
      const view = logoState((await brief()).states);
      expect(view.allowedCommands).toContain('generate');
      expect((await generate(view)).ok).toBe(true);
      expect(runtime.dispatched).toHaveLength(1);
    });
  });

  describe('confirmation answers after a panel edit', () => {
    async function pendingStyleThenPanel(runtime: ReturnType<typeof buildRuntime>) {
      await chatTurn(runtime, 'quizá algo rústico', { style_keywords: { value: 'rústico', confidence: 0.7 } });
      const question = await currentConfirm(runtime);
      expect(question.entries).toEqual([expect.objectContaining({ fieldName: 'style_keywords', pendingValue: 'rústico' })]);
      await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'style_keywords', value: 'moderno' });
      return question;
    }

    it.each(['sí', 'no'])('a stale bare «%s» to the old question leaves the panel value', async (reply) => {
      const runtime = buildRuntime();
      const question = await pendingStyleThenPanel(runtime);
      const provider = await chatTurn(runtime, reply, {}, { priorDecision: question });
      expect(provider.create).not.toHaveBeenCalled(); // fast path
      expect(field((await brief()).fields, 'style_keywords')).toMatchObject({ status: 'filled', value: 'moderno', source: 'panel' });
    });

    it('a fresh «sí» still confirms the pending value', async () => {
      const runtime = buildRuntime();
      await chatTurn(runtime, 'quizá algo rústico', { style_keywords: { value: 'rústico', confidence: 0.7 } });
      await chatTurn(runtime, 'sí', {}, { priorDecision: await currentConfirm(runtime) });
      expect(field((await brief()).fields, 'style_keywords')).toMatchObject({ status: 'filled', value: 'rústico', source: 'chat' });
    });

    it('an explicit correction to the confirm question replaces the panel value (reset_field path)', async () => {
      const runtime = buildRuntime();
      const question = await pendingStyleThenPanel(runtime);
      await chatTurn(runtime, 'no, el estilo es minimalista', { style_keywords: { value: 'minimalista', confidence: 0.95 } }, { priorDecision: question });
      expect(field((await brief()).fields, 'style_keywords')).toMatchObject({ status: 'filled', value: 'minimalista', source: 'chat' });
    });

    it('known bug: without a pending confirm question, a chat restatement does not replace a panel value', async () => {
      const runtime = buildRuntime();
      await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'business_name', value: 'Dulce Andino' });
      await chatTurn(runtime, 'no, el nombre es Dulces del Valle', { business_name: { value: 'Dulces del Valle', confidence: 0.95 } });
      expect(field((await brief()).fields, 'business_name')).toMatchObject({ value: 'Dulce Andino', source: 'panel' });
    });
  });

  describe('bug 5: «sí» to the confirmation of logo_keep (D35)', () => {
    type Turn = { id: string; stage: string; payload: Record<string, unknown> };

    // Replays a conversation the way chat.ts does: each answered turn persists its plan, and the next
    // reply is read against the prior decision chosen by `priorDecisionFrom` over `listTurns` order (newest first).
    async function converse() {
      const runtime = buildRuntime();
      const turns: Turn[] = [];
      let n = 0;
      const say = async (message: string, fields: Record<string, { value: string; confidence: number }> = {}) => {
        const id = `turn-${++n}`;
        await chatTurn(runtime, message, fields, { priorDecision: priorDecisionFrom(turns, id) });
        turns.unshift({ id, stage: 'responded', payload: { decisions: await runtime.core.peekNextDecision(CONVERSATION) } });
      };
      return { say };
    }

    it('confirms logo_keep, and restating it later does not bring it back to pending', async () => {
      const { say } = await converse();
      await say('quizá algo rústico', { style_keywords: { value: 'rústico', confidence: 0.7 } }); // turn 1 asks to confirm
      await say('sí'); // turn 2 confirms it
      await say('solo el color café oscuro', { logo_keep: { value: 'el color café oscuro', confidence: 0.7 } });
      expect(field((await brief()).fields, 'logo_keep')).toMatchObject({ status: 'pending_confirmation' });

      await say('sí'); // the reply the old lookup lost: it was read against turn 1's confirmation
      expect(field((await brief()).fields, 'logo_keep')).toMatchObject({ status: 'filled', value: 'el color café oscuro' });

      await say('como te dije, solo el color café', { logo_keep: { value: 'el color café oscuro', confidence: 0.7 } });
      expect(field((await brief()).fields, 'logo_keep')).toMatchObject({ status: 'filled', value: 'el color café oscuro' });
    });

    it('the lookup reads the MOST RECENT answered turn, not the oldest', () => {
      const confirm = (fieldName: string): PlannerDecision => ({ kind: 'confirm_fields', entries: [{ agentId: 'logo-agent', fieldName, pendingValue: 'x' }], reason: 'low_confidence' });
      const turns = [
        { id: 'current', stage: 'reserved', payload: {} },
        { id: 'new', stage: 'responded', payload: { decisions: [confirm('logo_keep')] } },
        { id: 'old', stage: 'responded', payload: { decisions: [confirm('visual_references')] } },
      ];
      expect(priorDecisionFrom(turns, 'current')).toMatchObject({ entries: [{ fieldName: 'logo_keep' }] });
    });
  });

  describe('precondition gate: the server verdict drives «Generar» in both directions', () => {
    type Step = (runtime: ReturnType<typeof buildRuntime>) => Promise<void>;
    const panel = (fieldName: string, value: string): Step => async () => {
      const result = await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName, value });
      if (!result.ok) throw new Error(result.code);
    };
    const chat = (fields: Record<string, { value: string; confidence: number }>): Step => async (runtime) => {
      await chatTurn(runtime, 'dato', fields);
    };

    // Fills every required logo field except `except` through the panel («Sin preferencia» counts as filled).
    const panelAllExcept = (...except: string[]): Step => async (runtime) => {
      for (const name of LOGO_REQUIRED.filter((n) => !except.includes(n))) await panel(name, 'Sin preferencia')(runtime);
    };
    it.each<[string, ReadonlyArray<Step>, ReadonlyArray<string>]>([
      ['empty brief', [], LOGO_BLOCKING],
      ['only the name, via panel', [panel('business_name', 'Dulce Andino')], LOGO_BLOCKING.filter((n) => n !== 'business_name')],
      [
        'one logo field still pending confirmation from chat',
        [panelAllExcept('logo_goal'), chat({ logo_goal: { value: 'verse profesional', confidence: 0.7 } })],
        ['logo_goal'],
      ],
      ['optional facts only', [panel('location', 'Cusco'), panel('style_keywords', 'rústico')], LOGO_BLOCKING],
      // D35: empty delegable fields never block; Generar sends them as the delegated value.
      ['only the delegable fields empty', [panelAllExcept(...LOGO_DELEGABLE)], []],
      [
        'pending field confirmed in the panel',
        [panelAllExcept('logo_goal'), chat({ logo_goal: { value: 'verse profesional', confidence: 0.7 } }), panel('logo_goal', 'verse profesional')],
        [],
      ],
      ['a «no aplica» answer counts as filled (chat)', [panelAllExcept('logo_avoid'), chat({ logo_avoid: { value: 'Sin preferencia', confidence: 1 } })], []],
      ['complete via panel', [panelAllExcept()], []],
    ])('%s', async (_name, steps, missing) => {
      const runtime = buildRuntime();
      for (const step of steps) await step(runtime);

      const view = logoState((await brief()).states);
      expect([...view.missingFields].sort()).toEqual([...missing].sort());
      const enabled = view.allowedCommands.includes('generate');
      // Preconditions met ⇔ the button is enabled.
      expect(enabled).toBe(missing.length === 0);

      const result = await generate(view);
      // Button enabled ⇔ the server accepts generate (and only then dispatches).
      expect(result.ok).toBe(enabled);
      expect(runtime.dispatched).toHaveLength(enabled ? 1 : 0);
      if (!result.ok) expect(result.reason).toBe('not_allowed');
    });

    it('generate sends every empty delegable field as the delegated value, so the agent receives the whole brief (D35)', async () => {
      const runtime = buildRuntime();
      await panelAllExcept(...LOGO_DELEGABLE, 'logo_keep')(runtime);
      await panel('logo_keep', 'solo el color café')(runtime);
      const view = logoState((await brief()).states);
      expect((await generate(view)).ok).toBe(true);
      const sent = runtime.dispatched[0].requirements as Record<string, unknown>;
      for (const name of LOGO_REQUIRED) expect(sent[name], name).toBeDefined();
      expect(sent.logo_keep).toBe('solo el color café');
      expect(sent.logo_typography).toBe(DELEGATED_FIELD_VALUE);
    });

    it('refuses a forged "enabled" command while preconditions are missing', async () => {
      const runtime = buildRuntime();
      await panel('business_name', 'Dulce Andino')(runtime);
      const view = logoState((await brief()).states);
      const result = await generate({ ...view, state: 'enabled' });
      expect(result.ok).toBe(false);
      expect(runtime.dispatched).toHaveLength(0);
    });
  });
});
