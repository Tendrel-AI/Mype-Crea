/**
 * KAN-32 end to end through the server action: without an approved name the
 * «Lema» card is blocked and a forged «Generar» is refused. With the brief
 * filled and a name approved, «Generar» dispatches through IAgentTransport
 * (LocalAdapter) to tagline-agent (fake IAgentLlm) with the approved name as
 * `upstream`; five taglines are stored, each with a rationale and the name's
 * id and fingerprint. «Aprobar» records the choice with history (KAN-34).
 * Approving another name flags the tagline «Potencialmente desactualizado»
 * (KAN-35) without regenerating it.
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
import { resetAgentLlm, setAgentLlm, type AgentCompletionRequest } from '../../../src/services/llm/agent-completion';
import { TAGLINE_PROMPT_VERSION } from '../../../agents/tagline-agent/handler';
import { inputVersion } from '../../../src/core/deliverable-inputs';
import { TEST_TENANT_ID, TEST_USER_ID } from '../../../src/core/__tests__/_fixtures';
import type { A2AMessage } from '../../../src/core/agent-types';
import type { ConversationId, DeliverableStateView, TaskId } from '../../../src/core/contracts';

const CONVERSATION = '6a1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f' as ConversationId;

const NAMES = ['Dulce Andino', 'Sabor de Altura', 'Mermeladas Killa', 'Frutos del Valle', 'Aguaymanto & Co.'];
const TAGLINES = ['El sabor de los Andes', 'Dulzura de altura', 'Como en casa', 'Fruta de verdad', 'Un pedacito de valle'];

function buildRuntime(shared?: {
  store: InMemoryConversationStore;
  workflow: InMemoryDeliverableWorkflowStore;
  approvals: InMemoryApprovalStore;
}) {
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
  const workflow = shared?.workflow ?? new InMemoryDeliverableWorkflowStore(undefined, newTaskId);
  const approvals = shared?.approvals ?? new InMemoryApprovalStore({
    kindOf: async (conversationId, deliverableId) =>
      (await workflow.listCandidates(conversationId as ConversationId)).find((c) => c.deliverableId === deliverableId)?.kind ?? null,
  });
  const store = shared?.store ?? new InMemoryConversationStore(registry.getFieldSchemas());
  core = new OrchestratorCoreImpl({
    store,
    registry,
    transport,
    notifier: new InProcessDecisionNotifier(),
    newTaskId,
    workflowFor: () => workflow,
    approvalsFor: () => approvals,
  });
  mocks.state.core = core;
  return { core, local, dispatched, approvals, workflow, store };
}

/** One fake model for both agents: names or taglines by the forced tool. */
function fakeLlm() {
  const complete = vi.fn(async (request: AgentCompletionRequest) => {
    const tool = (request.request.tool_choice as { function: { name: string } }).function.name;
    const candidates = tool === 'propose_taglines'
      ? TAGLINES.map((tagline) => ({ tagline, rationale: `Por qué «${tagline}» encaja.` }))
      : NAMES.map((name) => ({ name, rationale: `Por qué ${name} encaja.` }));
    return {
      provider: 'openrouter' as const,
      model: 'fake/naming-1',
      completion: {
        id: 'cmpl-1',
        choices: [{
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: tool, arguments: JSON.stringify({ candidates }) } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    };
  });
  setAgentLlm({ complete });
  return complete;
}

async function viewOf(agentId: string): Promise<DeliverableStateView> {
  const result = await loadDeliverableStatesAction({ conversationId: CONVERSATION });
  const view = result.ok ? result.states.find((s) => s.agentId === agentId) : undefined;
  if (!view) throw new Error(`no ${agentId} state`);
  return view;
}

async function command(agentId: string, kind: 'generate' | 'approve', extra: Record<string, unknown> = {}) {
  const view = await viewOf(agentId);
  return deliverableCommandAction({
    commandId: randomUUID(),
    conversationId: CONVERSATION,
    agentId,
    kind,
    expectedState: view.state,
    stateToken: view.stateToken,
    ...extra,
  });
}

async function startWithBrief(runtime: ReturnType<typeof buildRuntime>) {
  await runtime.core.startConversation(CONVERSATION, TEST_TENANT_ID, TEST_USER_ID);
  await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'business_category', value: 'alimentos' });
  await updateBriefFieldAction({ conversationId: CONVERSATION, fieldName: 'style_keywords', value: 'rústico' });
}

/** Generate names and approve the first; returns the name candidates. */
async function approveFirstName(runtime: ReturnType<typeof buildRuntime>) {
  await command('name-agent', 'generate');
  await runtime.local.waitForSettlement(runtime.dispatched.at(-1)!.taskId);
  const names = (await viewOf('name-agent')).candidates;
  expect(await command('name-agent', 'approve', { deliverableId: names[0].deliverableId, expectedApprovedId: null })).toMatchObject({ ok: true });
  return names;
}

describe('tagline-agent flow (KAN-32)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => resetAgentLlm());

  it('refuses Generar without an approved name: blocked, nothing dispatched, no model call', async () => {
    const runtime = buildRuntime();
    const llm = fakeLlm();
    await startWithBrief(runtime);
    // Names generated but none approved yet: still blocked.
    await command('name-agent', 'generate');
    await runtime.local.waitForSettlement(runtime.dispatched[0].taskId);
    llm.mockClear();

    const view = await viewOf('tagline-agent');
    expect(view).toMatchObject({ state: 'blocked', missingFields: [], missingUpstream: ['business_name'], allowedCommands: [] });
    // A forged command (the client ignored the disabled card) is still refused.
    const forged = await deliverableCommandAction({
      commandId: randomUUID(),
      conversationId: CONVERSATION,
      agentId: 'tagline-agent',
      kind: 'generate',
      expectedState: view.state,
      stateToken: view.stateToken,
    });
    expect(forged).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(runtime.dispatched).toHaveLength(1);
    expect(llm).not.toHaveBeenCalled();
    expect((await viewOf('tagline-agent')).candidates).toHaveLength(0);
  });

  it('Generar → five taglines tied to the approved name → Aprobar with history → a new name flags it, nothing regenerates', async () => {
    const runtime = buildRuntime();
    const llm = fakeLlm();
    await startWithBrief(runtime);
    const names = await approveFirstName(runtime);
    const [first, second] = names;

    expect(await viewOf('tagline-agent')).toMatchObject({ state: 'enabled', allowedCommands: ['generate', 'use_own'] });
    expect(await command('tagline-agent', 'generate')).toMatchObject({ ok: true });
    // KAN-43: a tagline generation is preflighted as an LLM call.
    expect(mocks.preflight).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'llm' }));
    const dispatched = runtime.dispatched.at(-1)!;
    expect(dispatched).toMatchObject({
      agentId: 'tagline-agent',
      requirements: { business_category: 'alimentos', style_keywords: 'rústico' },
      upstream: { business_name: { deliverableId: first.deliverableId, value: NAMES[0] } },
    });
    await runtime.local.waitForSettlement(dispatched.taskId);
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: 'naming', promptVersion: TAGLINE_PROMPT_VERSION }));

    // The task keeps the inputs it was generated under (history is never rewritten).
    const task = (await runtime.workflow.listTasks(CONVERSATION)).find((t) => t.id === dispatched.taskId)!;
    expect(task.upstreamApprovals).toEqual({ business_name: first.deliverableId });

    const review = await viewOf('tagline-agent');
    expect(review).toMatchObject({ state: 'in_review', stale: false });
    expect(review.candidates.map((c) => c.contentInline?.value)).toEqual(TAGLINES);
    for (const candidate of review.candidates) {
      expect(candidate.contentInline).toMatchObject({
        kind: 'text',
        metadata: {
          rationale: expect.stringContaining('encaja'),
          promptVersion: TAGLINE_PROMPT_VERSION,
          inputs: { business_name: { value: NAMES[0], version: inputVersion(NAMES[0]), deliverableId: first.deliverableId } },
        },
      });
    }

    // «Aprobar» (KAN-34): the choice, then a replacement, both in history.
    const [t1, t2] = review.candidates;
    expect(await command('tagline-agent', 'approve', { deliverableId: t1.deliverableId, expectedApprovedId: null })).toMatchObject({ ok: true });
    expect(await command('tagline-agent', 'approve', { deliverableId: t2.deliverableId, expectedApprovedId: t1.deliverableId })).toMatchObject({ ok: true });
    expect(runtime.approvals.historyFor(CONVERSATION).filter((a) => a.deliverableKind === 'tagline')).toMatchObject([
      { deliverableId: t1.deliverableId, replacedDeliverableId: null },
      { deliverableId: t2.deliverableId, replacedDeliverableId: t1.deliverableId },
    ]);
    const approved = await viewOf('tagline-agent');
    expect(approved).toMatchObject({ state: 'approved', approvedDeliverableId: t2.deliverableId, stale: false });

    // KAN-35: approving another name flags the tagline; it stays approved and nothing is dispatched.
    const dispatchCount = runtime.dispatched.length;
    await command('name-agent', 'approve', { deliverableId: second.deliverableId, expectedApprovedId: first.deliverableId });
    const flagged = await viewOf('tagline-agent');
    expect(flagged).toMatchObject({ state: 'approved', stale: true, approvedDeliverableId: t2.deliverableId, activeTask: null });
    // History rows are unchanged; only the derived per-candidate flag (KAN-29) turns on.
    expect(flagged.candidates.map((c) => ({ ...c, stale: false }))).toEqual(approved.candidates);
    expect(flagged.candidates.every((c) => c.stale)).toBe(true);
    // KAN-29: the approved name the tagline used is its upstream, not a brief input.
    expect(flagged.candidates[1].provenance).toMatchObject({
      promptVersion: 'tagline-agent.v1',
      upstream: [{ kind: 'business_name', deliverableId: first.deliverableId, value: NAMES[0] }],
    });
    expect(flagged.candidates[1].provenance.inputs.map((i) => i.field)).not.toContain('business_name');
    expect(flagged.allowedCommands).toContain('generate');
    expect(runtime.dispatched).toHaveLength(dispatchCount);
    expect(llm).toHaveBeenCalledTimes(2);
    // The stored candidate still names the inputs it used.
    expect(flagged.candidates[1].contentInline).toMatchObject({ metadata: { inputs: { business_name: { value: NAMES[0] } } } });

    // A reload (fresh core over the same persisted facts) derives the same flag.
    buildRuntime({ store: runtime.store, workflow: runtime.workflow, approvals: runtime.approvals });
    expect(await viewOf('tagline-agent')).toEqual(flagged);

    // Back to the original name: the stable references make it current again.
    await command('name-agent', 'approve', { deliverableId: first.deliverableId, expectedApprovedId: second.deliverableId });
    expect((await viewOf('tagline-agent')).stale).toBe(false);
  });

  it('a later Generar uses the newly approved name', async () => {
    const runtime = buildRuntime();
    fakeLlm();
    await startWithBrief(runtime);
    const [first, second] = await approveFirstName(runtime);
    await command('tagline-agent', 'generate');
    await runtime.local.waitForSettlement(runtime.dispatched.at(-1)!.taskId);
    await command('name-agent', 'approve', { deliverableId: second.deliverableId, expectedApprovedId: first.deliverableId });

    expect(await command('tagline-agent', 'generate')).toMatchObject({ ok: true });
    expect(runtime.dispatched.at(-1)).toMatchObject({ upstream: { business_name: { deliverableId: second.deliverableId, value: NAMES[1] } } });
    await runtime.local.waitForSettlement(runtime.dispatched.at(-1)!.taskId);
    const view = await viewOf('tagline-agent');
    expect(view.candidates).toHaveLength(10);
    // The current (newest) candidate was generated under the current name.
    expect(view.stale).toBe(false);
  });
});
