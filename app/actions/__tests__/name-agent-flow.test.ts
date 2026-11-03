/**
 * KAN-31 end to end through the server action: «Generar» on the name card →
 * IAgentTransport (LocalAdapter) → name-agent handler (fake IAgentLlm) → five
 * candidates in review with their metadata → «Aprobar» records the choice,
 * and a second «Aprobar» replaces it with history (KAN-34). Without the
 * required brief fields the server refuses and nothing is dispatched.
 *
 * Real OrchestratorCoreImpl over the default registry with in-memory stores;
 * identity, consent and the usage preflight are mocked at the repos boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => {
  const state: { core: unknown } = { core: null };
  const preflight = vi.fn(async (_input: { kind: string }) => ({ allowed: true, reservationId: null }) as { allowed: boolean; reservationId: null; reason?: string });
  const repos = vi.fn(() => ({
    conversations: { readPinnedConversation: vi.fn(async () => ({ state: 'pinned' })) },
    termsAcceptances: { hasAccepted: vi.fn(async () => true) },
    usage: { preflight },
  }));
  return { state, preflight, repos };
});

vi.mock('../../../src/auth/resolve-identity', () => ({
  resolveIdentity: async () => ({
    tenant: { id: '00000000-0000-0000-0000-000000000001' },
    user: { id: '00000000-0000-0000-0000-000000000002' },
  }),
}));
vi.mock('../../../src/repos', () => ({ repos: mocks.repos, systemRepos: mocks.repos }));
vi.mock('../../../src/core/orchestrator/runtime', () => ({ getOrchestrator: () => mocks.state.core }));

import { updateBriefFieldAction } from '../brief';
import { deliverableCommandAction, loadDeliverableStatesAction } from '../deliverable-command';
import { InProcessDecisionNotifier, OrchestratorCoreImpl } from '../../../src/core/orchestrator/orchestrator-core';
import { InMemoryConversationStore } from '../../../src/core/orchestrator/in-memory-store';
import { InMemoryDeliverableWorkflowStore } from '../../../src/core/orchestrator/deliverable-workflow';
import { buildDefaultRegistry } from '../../../src/core/orchestrator/bootstrap-registry';
import { InMemoryApprovalStore } from '../../../src/core/approvals';
import { LocalAdapter } from '../../../src/transport/local-adapter';
import { newTaskId } from '../../../src/core/ids';
import { resetAgentLlm, setAgentLlm } from '../../../src/services/llm/agent-completion';
import { NAME_PROMPT_VERSION } from '../../../agents/name-agent/handler';
import { TEST_TENANT_ID, TEST_USER_ID } from '../../../src/core/__tests__/_fixtures';
import type { A2AMessage } from '../../../src/core/agent-types';
import type { ConversationId, DeliverableStateView, TaskId } from '../../../src/core/contracts';

const CONVERSATION = '6a1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f' as ConversationId;

const NAMES = ['Dulce Andino', 'Sabor de Altura', 'Mermeladas Killa', 'Frutos del Valle', 'Aguaymanto & Co.'];

function buildRuntime() {
  const registry = buildDefaultRegistry();
  const dispatched: A2AMessage[] = [];
  let core: OrchestratorCoreImpl | null = null;
  const local = new LocalAdapter(registry, (taskId, state) => core?.onTaskSettled(taskId, state));
  const transport = {
    dispatch: (message: A2AMessage) => {
      dispatched.push(message);
      return local.dispatch(message);
    },
    getResult: (taskId: TaskId) => local.getResult(taskId),
  };
  const workflow = new InMemoryDeliverableWorkflowStore(undefined, newTaskId);
  const approvals = new InMemoryApprovalStore({
    kindOf: async (conversationId, deliverableId) =>
      (await workflow.listCandidates(conversationId as ConversationId)).find((c) => c.deliverableId === deliverableId)?.kind ?? null,
  });
  core = new OrchestratorCoreImpl({
    store: new InMemoryConversationStore(registry.getFieldSchemas()),
    registry,
    transport,
    notifier: new InProcessDecisionNotifier(),
    newTaskId,
    workflowFor: () => workflow,
    approvalsFor: () => approvals,
  });
  mocks.state.core = core;
  return { core, local, dispatched, approvals };
}

function fakeNamingLlm() {
  const complete = vi.fn(async () => ({
    provider: 'openrouter' as const,
    model: 'fake/naming-1',
    completion: {
      id: 'cmpl-1',
      choices: [{
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function' as const,
            function: {
              name: 'propose_business_names',
              arguments: JSON.stringify({ candidates: NAMES.map((name) => ({ name, rationale: `Por qué ${name} encaja.` })) }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
  }));
  setAgentLlm({ complete });
  return complete;
}

async function nameView(): Promise<DeliverableStateView> {
  const result = await loadDeliverableStatesAction({ conversationId: CONVERSATION });
  const view = result.ok ? result.states.find((s) => s.agentId === 'name-agent') : undefined;
  if (!view) throw new Error('no name-agent state');
  return view;
}

async function command(kind: 'generate' | 'approve', extra: Record<string, unknown> = {}) {
  const view = await nameView();
  return deliverableCommandAction({
    commandId: randomUUID(),
    conversationId: CONVERSATION,
    agentId: 'name-agent',
    kind,
    expectedState: view.state,
    stateToken: view.stateToken,
    ...extra,
  });
}

describe('name-agent flow (KAN-31)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => resetAgentLlm());

  it('Generar → five candidates with metadata → Aprobar, replaceable with history', async () => {
    const runtime = buildRuntime();
    const llm = fakeNamingLlm();
    await runtime.core.startConversation(CONVERSATION, TEST_TENANT_ID, TEST_USER_ID);
    await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'business_category', value: 'alimentos' });
    await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'style_keywords', value: 'rústico' });

    expect((await nameView()).allowedCommands).toContain('generate');
    const generated = await command('generate');
    expect(generated.ok).toBe(true);
    // KAN-43: a name generation is preflighted as an LLM call, not an image.
    expect(mocks.preflight).toHaveBeenCalledWith(expect.objectContaining({ kind: 'llm' }));
    expect(runtime.dispatched).toHaveLength(1);
    expect(runtime.dispatched[0]).toMatchObject({ agentId: 'name-agent', requirements: { business_category: 'alimentos', style_keywords: 'rústico' } });
    await runtime.local.waitForSettlement(runtime.dispatched[0].taskId);
    expect(llm).toHaveBeenCalledTimes(1);

    const review = await nameView();
    expect(review.state).toBe('in_review');
    expect(review.candidates.map((c) => c.contentInline?.value)).toEqual(NAMES);
    expect(review.candidates[0].contentInline).toMatchObject({
      kind: 'text',
      metadata: {
        rationale: 'Por qué Dulce Andino encaja.',
        promptVersion: NAME_PROMPT_VERSION,
        model: 'fake/naming-1',
        inputs: { business_category: { value: 'alimentos', version: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) } },
      },
    });

    const [first, second] = review.candidates;
    expect(await command('approve', { deliverableId: first.deliverableId, expectedApprovedId: null })).toMatchObject({ ok: true });
    expect(await nameView()).toMatchObject({ state: 'approved', approvedDeliverableId: first.deliverableId });

    expect(await command('approve', { deliverableId: second.deliverableId, expectedApprovedId: first.deliverableId })).toMatchObject({ ok: true });
    expect((await nameView()).approvedDeliverableId).toBe(second.deliverableId);
    expect(runtime.approvals.historyFor(CONVERSATION)).toMatchObject([
      { deliverableKind: 'business_name', deliverableId: first.deliverableId, replacedDeliverableId: null },
      { deliverableKind: 'business_name', deliverableId: second.deliverableId, replacedDeliverableId: first.deliverableId },
    ]);
  });

  it('refuses Generar without the rubro: nothing is dispatched and no model is called', async () => {
    const runtime = buildRuntime();
    const llm = fakeNamingLlm();
    await runtime.core.startConversation(CONVERSATION, TEST_TENANT_ID, TEST_USER_ID);
    await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'style_keywords', value: 'rústico' });

    const view = await nameView();
    expect(view).toMatchObject({ state: 'blocked', missingFields: ['business_category'] });
    expect(view.allowedCommands).not.toContain('generate');
    // A forged command (the client ignored the disabled button) is still refused.
    const forged = await deliverableCommandAction({
      commandId: randomUUID(),
      conversationId: CONVERSATION,
      agentId: 'name-agent',
      kind: 'generate',
      expectedState: view.state,
      stateToken: view.stateToken,
    });
    expect(forged).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(runtime.dispatched).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
    expect((await nameView()).candidates).toHaveLength(0);
  });
});
