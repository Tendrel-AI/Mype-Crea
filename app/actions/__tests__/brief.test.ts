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
  const repos = vi.fn(() => ({
    conversations: { readPinnedConversation: vi.fn(async () => ({ state: 'pinned' })) },
    termsAcceptances: { hasAccepted: vi.fn(async (version: string) => acceptedVersions.has(version)) },
    llmCalls: { record: vi.fn(async () => 'fake-llm-call-id') },
  }));
  return { state, acceptedVersions, repos };
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
import { InProcessDecisionNotifier, OrchestratorCoreImpl } from '../../../src/core/orchestrator/orchestrator-core';
import { InMemoryConversationStore } from '../../../src/core/orchestrator/in-memory-store';
import { InMemoryDeliverableWorkflowStore } from '../../../src/core/orchestrator/deliverable-workflow';
import { buildDefaultRegistry } from '../../../src/core/orchestrator/bootstrap-registry';
import { ChatInputAdapter } from '../../../src/adapters/chat-input-adapter';
import { newTaskId } from '../../../src/core/ids';
import { resetProvider, setProvider } from '../../../src/services/llm';
import { FakeLLMProvider, TEST_TENANT_ID, TEST_USER_ID } from '../../../src/core/__tests__/_fixtures';
import type { A2AMessage, IAgentTransport } from '../../../src/core/agent-types';
import type { ConversationId, DeliverableStateView } from '../../../src/core/contracts';
import { TERMS_REQUIRED_MESSAGE } from '../../../src/consent/terms';
import { BRIEF_CATALOG } from '../../../src/core/brief';

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
  });
  mocks.state.core = core;
  return { core, store, registry, dispatched };
}

/** One chat turn's input side, as app/actions/chat.ts runs it, with a scripted Extractor. */
async function chatTurn(
  runtime: ReturnType<typeof buildRuntime>,
  userMessage: string,
  fields: Record<string, { value: string; confidence: number }>,
) {
  setProvider(
    new FakeLLMProvider({ purpose: 'extractor', modelId: 'google/gemini-2.5-flash' }).scriptToolCall(
      'submit_extracted_fields',
      // The tool schema requires every known field; absent ones are null.
      JSON.stringify({ fields: { ...Object.fromEntries(BRIEF_CATALOG.map((spec) => [spec.name, null])), ...fields } }),
    ),
  );
  await runtime.core.startConversation(CONVERSATION, TEST_TENANT_ID, TEST_USER_ID);
  const adapter = new ChatInputAdapter(runtime.core, runtime.registry);
  const delta = await adapter.extract({
    conversationId: CONVERSATION,
    userMessage,
    llmContext: { tenant: { id: TEST_TENANT_ID }, user: { id: TEST_USER_ID }, conversationId: CONVERSATION, promptVersion: 'extractor.v5' },
  });
  await runtime.core.applyDelta(delta);
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
    expect(fields.map((f) => f.label)).toEqual([
      'Nombre del negocio',
      'Rubro',
      'Estilo',
      'Colores',
      'Producto',
      'Composición',
      'Presentación',
      'Fabricante',
    ]);
    expect(fields.every((f) => f.status === 'empty' && f.value === null && f.source === null)).toBe(true);
  });

  it('panel channel: a normalized value is filled at once and attributed to the panel', async () => {
    const runtime = buildRuntime();
    const result = await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'product_name', value: '  Mermelada\nde  aguaymanto ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(field(result.fields, 'product_name')).toMatchObject({ status: 'filled', value: 'Mermelada de aguaymanto', source: 'panel' });
    const snapshot = await runtime.core.getSnapshot(CONVERSATION);
    expect(snapshot.agentStates['logo-agent'].optionalFields.product_name).toMatchObject({ source: 'brief-panel', confidence: 1 });
  });

  it('chat channel: an extracted value reaches the same brief, attributed to the chat', async () => {
    const runtime = buildRuntime();
    await chatTurn(runtime, 'Mi negocio se llama Dulce Andino y fabricamos mermeladas', {
      business_name: { value: 'Dulce Andino', confidence: 0.95 },
      manufacturer: { value: 'Dulce Andino', confidence: 0.95 },
    });
    const { fields } = await brief();
    expect(field(fields, 'business_name')).toMatchObject({ status: 'filled', value: 'Dulce Andino', source: 'chat' });
    expect(field(fields, 'manufacturer')).toMatchObject({ status: 'filled', value: 'Dulce Andino', source: 'chat' });
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
    await chatTurn(runtime, 'Usamos frascos de vidrio de 250 g', { product_presentation: { value: 'Frasco de vidrio de 250 g', confidence: 0.95 } });

    // Reload: a fresh core (new process) over the same persisted store.
    buildRuntime(runtime.store);
    const { fields } = await brief();
    expect(field(fields, 'business_name')).toMatchObject({ status: 'filled', value: 'Dulces Andinos', source: 'panel' });
    expect(field(fields, 'product_presentation')).toMatchObject({ status: 'filled', value: 'Frasco de vidrio de 250 g', source: 'chat' });
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
    expect(mocks.repos).not.toHaveBeenCalled();
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

  describe('precondition gate: the server verdict drives «Generar» in both directions', () => {
    type Step = (runtime: ReturnType<typeof buildRuntime>) => Promise<void>;
    const panel = (fieldName: string, value: string): Step => async () => {
      const result = await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName, value });
      if (!result.ok) throw new Error(result.code);
    };
    const chat = (fields: Record<string, { value: string; confidence: number }>): Step => (runtime) =>
      chatTurn(runtime, 'dato', fields);

    it.each<[string, ReadonlyArray<Step>, ReadonlyArray<string>]>([
      ['empty brief', [], ['business_name', 'style_keywords']],
      ['only the name, via panel', [panel('business_name', 'Dulce Andino')], ['style_keywords']],
      [
        'style still pending confirmation from chat',
        [panel('business_name', 'Dulce Andino'), chat({ style_keywords: { value: 'rústico', confidence: 0.7 } })],
        ['style_keywords'],
      ],
      ['optional product facts only', [panel('product_name', 'Mermelada'), panel('manufacturer', 'Dulce Andino')], ['business_name', 'style_keywords']],
      [
        'pending style confirmed in the panel',
        [panel('business_name', 'Dulce Andino'), chat({ style_keywords: { value: 'rústico', confidence: 0.7 } }), panel('style_keywords', 'rústico')],
        [],
      ],
      [
        'complete via chat',
        [chat({ business_name: { value: 'Dulce Andino', confidence: 0.95 }, style_keywords: { value: 'rústico', confidence: 0.95 } })],
        [],
      ],
      ['complete via panel', [panel('business_name', 'Dulce Andino'), panel('style_keywords', 'moderno')], []],
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
