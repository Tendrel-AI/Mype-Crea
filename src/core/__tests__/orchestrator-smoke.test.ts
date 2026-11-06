import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InProcessDecisionNotifier,
  OrchestratorCoreImpl,
} from '../orchestrator/orchestrator-core';
import { InProcessArtifactNotifier } from '../orchestrator/artifact-notifier';
import {
  InMemoryConversationStore,
  type IConversationStore,
} from '../orchestrator/in-memory-store';
import { LocalAdapter } from '../../transport/local-adapter';
import { newTaskId } from '../ids';
import {
  CONFIDENCE_THRESHOLDS,
  type FieldDelta,
  type PlannerDecision,
} from '../contracts';
import { buildDelta, buildSingleAgentFixtureRegistry } from './_fixtures';
import type { A2AMessage, IAgentTransport, TaskState } from '../agent-types';
import { InMemoryDeliverableWorkflowStore } from '../orchestrator/deliverable-workflow';

/**
 * KAN-28: a merge never dispatches. Generation starts only through the typed
 * «Generar» command, re-validated against the server-derived state.
 */
async function issueGenerate(core: OrchestratorCoreImpl, conversationId: string, agentId: string) {
  const view = (await core.getDeliverableStates(conversationId)).find((s) => s.agentId === agentId);
  if (!view) throw new Error(`no deliverable state for ${agentId}`);
  const result = await core.executeCommand({
    kind: 'generate',
    commandId: randomUUID(),
    conversationId,
    agentId,
    expectedState: view.state,
    stateToken: view.stateToken,
  });
  if (!result.ok || !result.taskId) throw new Error(`Generar rejected: ${result.ok ? 'no task' : result.reason}`);
  return result.taskId;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wraps a store so every call yields to the event loop several times before
 * touching state, like a real database round trip. Settlement through the
 * core then spans many macrotasks, which is what the Postgres store does.
 */
function withSimulatedIo(store: IConversationStore, ticks = 5): IConversationStore {
  const io = async () => {
    for (let i = 0; i < ticks; i += 1) await flushMicrotasks();
  };
  return {
    getOrCreate: async (...args) => { await io(); return store.getOrCreate(...args); },
    get: async (...args) => { await io(); return store.get(...args); },
    updateFieldSlot: async (...args) => { await io(); return store.updateFieldSlot(...args); },
    recordDispatch: async (...args) => { await io(); return store.recordDispatch(...args); },
    clearDispatch: async (...args) => { await io(); return store.clearDispatch(...args); },
  };
}

function buildHarness(options: { readonly simulatedIo?: boolean } = {}) {
  const { registry, agentId } = buildSingleAgentFixtureRegistry();
  const memoryStore = new InMemoryConversationStore(registry.getFieldSchemas());
  const store = options.simulatedIo ? withSimulatedIo(memoryStore) : memoryStore;

  let coreRef: OrchestratorCoreImpl | null = null;
  // Return the settlement promise so LocalAdapter.waitForSettlement covers it.
  const transport = new LocalAdapter(registry, (taskId, state) =>
    coreRef?.onTaskSettled(taskId, state),
  );

  const notifier = new InProcessDecisionNotifier();
  const core = new OrchestratorCoreImpl({
    store,
    registry,
    transport,
    notifier,
    newTaskId,
  });
  coreRef = core;

  return { core, store, registry, transport, notifier, agentId };
}

function buildControlledHarness() {
  const { registry, agentId } = buildSingleAgentFixtureRegistry();
  const store = new InMemoryConversationStore(registry.getFieldSchemas());
  // Shared like a database would be, so a "restarted" core sees the same tasks.
  const workflow = new InMemoryDeliverableWorkflowStore(undefined, newTaskId);
  const messages: A2AMessage[] = [];
  const transport: IAgentTransport = {
    dispatch: async (message) => {
      messages.push(message);
      return { taskId: message.taskId };
    },
    getResult: async (): Promise<TaskState> => ({ status: 'pending' }),
  };
  const notifier = new InProcessDecisionNotifier();
  const core = new OrchestratorCoreImpl({
    store,
    registry,
    transport,
    notifier,
    newTaskId,
    workflowFor: () => workflow,
  });
  return { core, messages, notifier, agentId, registry, store, workflow };
}

function readyDelta(conversationId: string, agentId: string, source: string) {
  return buildDelta({
    conversationId,
    source,
    fields: {
      [agentId]: {
        business_name: { value: 'Sazón Andino', confidence: 1 },
        business_profile: { value: 'Comida peruana', confidence: 1 },
        tone: { value: 'cercano', confidence: 1 },
        unregistered_field: { value: 'ignorar', confidence: 1 },
      },
      'unknown-agent': { business_name: { value: 'No aceptar', confidence: 1 } },
    },
  });
}

describe('orchestrator smoke (agent-agnostic)', () => {
  it('drives a fixture agent end-to-end via FieldDelta -> dispatch -> announce_completion', async () => {
    const { core, notifier, agentId, transport } = buildHarness();
    const conversationId = randomUUID();
    const tenantId = randomUUID();

    const observed: PlannerDecision[] = [];
    const subscription = notifier.subscribe(conversationId, (d) => {
      observed.push(d);
    });

    await core.startConversation(conversationId, tenantId, randomUUID());

    // 1. With nothing filled, the planner asks for both required fields of
    //    the focus agent in a single request_fields decision (lex-first
    //    `business_name` then `business_profile`).
    const planEmpty = await core.getNextDecision(conversationId);
    expect(planEmpty).toEqual([
      {
        kind: 'request_fields',
        agentId,
        fields: [
          { fieldName: 'business_name', promptHint: expect.any(String) },
          { fieldName: 'business_profile', promptHint: expect.any(String) },
        ],
      },
    ]);

    // 2. Submit business_name with form-grade confidence.
    await core.applyDelta(
      buildDelta({
        conversationId,
        source: 'test-form',
        fields: {
          [agentId]: {
            business_name: { value: 'Sazón Andino', confidence: 1.0 },
          },
        },
      }),
    );

    const planAfterName = await core.getNextDecision(conversationId);
    expect(planAfterName).toEqual([
      {
        kind: 'request_fields',
        agentId,
        fields: [{ fieldName: 'business_profile', promptHint: expect.any(String) }],
      },
    ]);

    // 3. Submit business_profile -> all required fields filled. Nothing is
    //    dispatched by the merge (KAN-64): the planner offers «Generar».
    await core.applyDelta(
      buildDelta({
        conversationId,
        source: 'test-form',
        fields: {
          [agentId]: {
            business_profile: {
              value: 'Comida tradicional peruana lista para llevar.',
              confidence: 1.0,
            },
          },
        },
      }),
    );

    expect(observed.some((d) => d.kind === 'announce_dispatch')).toBe(false);
    expect(await core.getNextDecision(conversationId)).toEqual([
      { kind: 'offer_generation', agentId, deliverableKind: agentId },
    ]);

    // 4. The user presses «Generar».
    await issueGenerate(core, conversationId, agentId);
    const dispatchAnnouncement = observed.find((d) => d.kind === 'announce_dispatch');
    expect(dispatchAnnouncement).toMatchObject({
      kind: 'announce_dispatch',
      agentId,
    });
    if (dispatchAnnouncement?.kind !== 'announce_dispatch') throw new Error('expected dispatch');
    await transport.waitForSettlement(dispatchAnnouncement.taskId);

    const completion = observed.find((d) => d.kind === 'announce_completion');
    expect(completion).toBeDefined();
    if (completion?.kind === 'announce_completion') {
      expect(completion.agentId).toBe(agentId);
      // The in-memory workflow store stands in for the worker's deliverable
      // insert: one candidate per artifact.
      expect(completion.deliverableIds.length).toBe(completion.artifacts.length);
      // The fixture echo handler returns one artifact per filled requirement;
      // those artifacts must reach the decision so the Responder can present
      // them inline.
      expect(completion.artifacts.length).toBeGreaterThan(0);
    }

    // 5. The snapshot reflects the filled slots and the dispatch lifecycle.
    // After settle, lastDispatchedTaskId is cleared; iterationCount stays at
    // 1. The deliverable is now in review (Iterar / Aprobar).
    const snapshot = await core.getSnapshot(conversationId);
    const state = snapshot.agentStates[agentId];
    expect(state.requiredFields.business_name.status).toBe('filled');
    expect(state.requiredFields.business_profile.status).toBe('filled');
    expect(state.lastDispatchedTaskId).toBeUndefined();
    expect(state.iterationCount).toBe(1);
    const [view] = await core.getDeliverableStates(conversationId);
    expect(view).toMatchObject({ state: 'in_review', allowedCommands: ['iterate', 'approve'] });

    subscription.dispose();
  });

  it('treats < STORE_AND_CONFIRM confidence values as discarded', async () => {
    const { core, agentId } = buildHarness();
    const conversationId = randomUUID();
    const tenantId = randomUUID();

    await core.startConversation(conversationId, tenantId, randomUUID());

    await core.applyDelta(
      buildDelta({
        conversationId,
        source: 'test-chat',
        fields: {
          [agentId]: {
            business_name: { value: 'maybe a name?', confidence: 0.4 },
          },
        },
      }),
    );

    const plan = await core.getNextDecision(conversationId);
    // < STORE_AND_CONFIRM confidence is dropped, so the planner still asks
    // for the field (alongside any other still-empty required fields).
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: 'request_fields', agentId });
    if (plan[0].kind === 'request_fields') {
      expect(plan[0].fields.map((f) => f.fieldName)).toContain('business_name');
    }

    const snapshot = await core.getSnapshot(conversationId);
    expect(snapshot.agentStates[agentId].requiredFields.business_name.status).toBe('empty');
  });

  it('stores STORE_AND_CONFIRM-range values as pending_confirmation', async () => {
    const { core, agentId } = buildHarness();
    const conversationId = randomUUID();
    const tenantId = randomUUID();

    await core.startConversation(conversationId, tenantId, randomUUID());

    await core.applyDelta(
      buildDelta({
        conversationId,
        source: 'test-chat',
        fields: {
          [agentId]: {
            business_name: { value: 'Sazón Andino', confidence: 0.7 },
          },
        },
      }),
    );

    const plan = await core.getNextDecision(conversationId);
    expect(plan).toEqual([
      {
        kind: 'confirm_field',
        agentId,
        fieldName: 'business_name',
        pendingValue: 'Sazón Andino',
        reason: 'low_confidence',
      },
    ]);
  });

  it.each([
    {
      label: 'just below STORE_AND_CONFIRM',
      confidence: CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM - Number.EPSILON,
      slotStatus: 'empty',
      decisionKind: 'request_fields',
    },
    {
      label: 'at STORE_AND_CONFIRM',
      confidence: CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM,
      slotStatus: 'pending_confirmation',
      decisionKind: 'confirm_field',
    },
    {
      label: 'just below AUTO_ACCEPT',
      confidence: CONFIDENCE_THRESHOLDS.AUTO_ACCEPT - Number.EPSILON,
      slotStatus: 'pending_confirmation',
      decisionKind: 'confirm_field',
    },
    {
      label: 'at AUTO_ACCEPT',
      confidence: CONFIDENCE_THRESHOLDS.AUTO_ACCEPT,
      slotStatus: 'filled',
      decisionKind: 'request_fields',
    },
  ])('applies confidence boundary: $label', async ({ confidence, slotStatus, decisionKind }) => {
    const { core, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());
    await core.applyDelta(buildDelta({
      conversationId,
      source: 'test-chat',
      fields: {
        [agentId]: { business_name: { value: 'Sazón Andino', confidence } },
      },
    }));

    const snapshot = await core.getSnapshot(conversationId);
    expect(snapshot.agentStates[agentId].requiredFields.business_name.status).toBe(slotStatus);
    const plan = await core.getNextDecision(conversationId);
    expect(plan[0]?.kind).toBe(decisionKind);
  });

  it('keeps merge and dispatch behavior independent of the audit-only source', async () => {
    const first = buildControlledHarness();
    const second = buildControlledHarness();
    const conversationA = randomUUID();
    const conversationB = randomUUID();
    await first.core.startConversation(conversationA, randomUUID(), randomUUID());
    await second.core.startConversation(conversationB, randomUUID(), randomUUID());

    await first.core.applyDelta(readyDelta(conversationA, first.agentId, 'chat-es'));
    await second.core.applyDelta(readyDelta(conversationB, second.agentId, 'form'));
    expect(await first.core.getDeliverableStates(conversationA)).toEqual(
      (await second.core.getDeliverableStates(conversationB)).map((view) => ({ ...view })),
    );
    await issueGenerate(first.core, conversationA, first.agentId);
    await issueGenerate(second.core, conversationB, second.agentId);

    const snapshotA = await first.core.getSnapshot(conversationA);
    const snapshotB = await second.core.getSnapshot(conversationB);
    const stateA = snapshotA.agentStates[first.agentId];
    const stateB = snapshotB.agentStates[second.agentId];
    // KAN-26: each slot records its own source (provenance); nothing else differs.
    const withoutSource = (slots: object) =>
      Object.fromEntries(Object.entries(slots).map(([name, { source: _source, ...slot }]) => [name, slot]));
    expect(stateA.requiredFields.business_name).toMatchObject({ source: 'chat-es' });
    expect(stateB.requiredFields.business_name).toMatchObject({ source: 'form' });
    expect(withoutSource(stateA.requiredFields)).toEqual(withoutSource(stateB.requiredFields));
    expect(withoutSource(stateA.optionalFields)).toEqual(withoutSource(stateB.optionalFields));
    expect(stateA.iterationCount).toBe(stateB.iterationCount);
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    expect(first.messages[0].requirements).toEqual(second.messages[0].requirements);
  });

  it('dispatches once with only schema-owned filled requirements and ignores unknown agents and fields', async () => {
    const { core, messages, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());

    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-chat'));
    expect(messages).toHaveLength(0);
    await issueGenerate(core, conversationId, agentId);

    expect(messages).toHaveLength(1);
    expect(messages[0].requirements).toEqual({
      business_name: 'Sazón Andino',
      business_profile: 'Comida peruana',
      tone: 'cercano',
    });
    const snapshot = await core.getSnapshot(conversationId);
    expect(snapshot.agentStates[agentId].requiredFields.unregistered_field).toBeUndefined();
    expect(snapshot.agentStates['unknown-agent']).toBeUndefined();
  });

  it('never dispatches from a merge: not when ready, not while in flight, not after it settles', async () => {
    const { core, messages, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-chat'));
    expect(messages).toHaveLength(0);
    const taskId = await issueGenerate(core, conversationId, agentId);
    expect(messages[0].taskId).toBe(taskId);

    await core.applyDelta(readyDelta(conversationId, agentId, 'test-chat'));
    expect(messages).toHaveLength(1);

    await core.onTaskSettled(taskId, {
      status: 'completed',
      result: {
        status: 'completed',
        taskId,
        artifacts: [{ kind: 'text', inline: { value: 'done' } }],
        completedAt: new Date().toISOString() as `${string}T${string}Z`,
      },
    });
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-chat'));
    expect(messages).toHaveLength(1);
  });

  it('keeps dispatch available to the caller after applyDelta internal planning', async () => {
    const { core, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    await issueGenerate(core, conversationId, agentId);
    await core.applyDelta(buildDelta({ conversationId, source: 'test-chat', fields: {} }));

    const dispatchPlan = await core.getNextDecision(conversationId);
    expect(dispatchPlan.some((decision) => decision.kind === 'announce_dispatch')).toBe(true);
  });

  it('keeps settled completion available to the caller after onTaskSettled internal planning', async () => {
    const { core, messages, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    const taskId = await issueGenerate(core, conversationId, agentId);
    expect(messages[0].taskId).toBe(taskId);
    const artifacts = [{ kind: 'text', inline: { value: 'result' } }];
    await core.onTaskSettled(taskId, {
      status: 'completed',
      result: {
        status: 'completed',
        taskId,
        artifacts,
        completedAt: new Date().toISOString() as `${string}T${string}Z`,
      },
    });
    const completionPlan = await core.getNextDecision(conversationId);
    expect(completionPlan).toContainEqual(expect.objectContaining({
      kind: 'announce_completion', agentId, taskId, artifacts,
    }));
  });

  it('does not acknowledge a completion that arrived after peeking its dispatch', async () => {
    const { core, messages, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    await issueGenerate(core, conversationId, agentId);
    const dispatchPlan = await core.peekNextDecision(conversationId);
    const dispatch = dispatchPlan.find((decision) => decision.kind === 'announce_dispatch');
    expect(dispatch).toBeDefined();
    if (!dispatch || dispatch.kind !== 'announce_dispatch') throw new Error('expected dispatch');

    const artifacts = [{ kind: 'text', inline: { value: 'result' } }];
    await core.onTaskSettled(dispatch.taskId, {
      status: 'completed',
      result: {
        status: 'completed',
        taskId: dispatch.taskId,
        artifacts,
        completedAt: new Date().toISOString() as `${string}T${string}Z`,
      },
    });
    await core.acknowledgeDecisions(conversationId, [dispatch]);
    expect(await core.peekNextDecision(conversationId)).toContainEqual(expect.objectContaining({
      kind: 'announce_completion', taskId: dispatch.taskId,
    }));
  });

  it('settles a task after restart when trusted persisted context is supplied', async () => {
    const { core, messages, agentId, registry, store, workflow } = buildControlledHarness();
    const conversationId = randomUUID();
    const tenantId = randomUUID();
    const userId = randomUUID();
    await core.startConversation(conversationId, tenantId, userId);
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    const taskId = await issueGenerate(core, conversationId, agentId);
    expect(messages[0].taskId).toBe(taskId);

    const restartedNotifier = new InProcessDecisionNotifier();
    const artifactNotifier = new InProcessArtifactNotifier();
    const restartedCore = new OrchestratorCoreImpl({
      store,
      registry,
      transport: {
        dispatch: async (message) => ({ taskId: message.taskId }),
        getResult: async (): Promise<TaskState> => ({ status: 'pending' }),
      },
      notifier: restartedNotifier,
      artifactNotifier,
      newTaskId,
      workflowFor: () => workflow,
    });
    // Re-register tenant ownership as bootstrap would after loading the persisted conversation.
    await restartedCore.startConversation(conversationId, tenantId, userId);

    const publishedArtifacts: unknown[] = [];
    const observedDecisions: PlannerDecision[] = [];
    artifactNotifier.subscribe(conversationId, (event) => publishedArtifacts.push(event));
    restartedNotifier.subscribe(conversationId, (decision) => observedDecisions.push(decision));
    const artifacts = [{ kind: 'image', url: 'https://example.test/logo.png' }];
    await restartedCore.onTaskSettled(taskId, {
      status: 'completed',
      result: {
        status: 'completed',
        taskId,
        artifacts,
        completedAt: new Date().toISOString() as `${string}T${string}Z`,
      },
    }, [], { tenantId, conversationId, ownerUserId: userId, agentId });

    const recoveredSnapshot = await restartedCore.getSnapshot(conversationId);
    expect({
      inFlightTaskId: recoveredSnapshot.agentStates[agentId].lastDispatchedTaskId,
      completion: observedDecisions.find((decision) => decision.kind === 'announce_completion'),
      publishedArtifacts,
    }).toEqual({
      inFlightTaskId: undefined,
      completion: expect.objectContaining({ kind: 'announce_completion', taskId, artifacts }),
      publishedArtifacts: [expect.objectContaining({ conversationId, agentId, taskId, artifacts })],
    });
  });
  it('waitForSettlement is a barrier for the core settlement when the store does I/O (KAN-78)', async () => {
    const { core, notifier, agentId, transport } = buildHarness({ simulatedIo: true });
    const conversationId = randomUUID();
    const observed: PlannerDecision[] = [];
    const subscription = notifier.subscribe(conversationId, (d) => observed.push(d));
    await core.startConversation(conversationId, randomUUID(), randomUUID());

    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    await issueGenerate(core, conversationId, agentId);
    const dispatch = observed.find((d) => d.kind === 'announce_dispatch');
    if (dispatch?.kind !== 'announce_dispatch') throw new Error('expected dispatch');

    // The pre-KAN-78 test waited one macrotask. With store I/O the core is
    // still settling at that point, so that wait was never a barrier.
    await flushMicrotasks();
    expect(observed.some((d) => d.kind === 'announce_completion')).toBe(false);

    const settled = await transport.waitForSettlement(dispatch.taskId);
    expect(settled.status).toBe('completed');
    expect(observed.filter((d) => d.kind === 'announce_completion')).toContainEqual(
      expect.objectContaining({ kind: 'announce_completion', agentId, taskId: dispatch.taskId }),
    );
    const snapshot = await core.getSnapshot(conversationId);
    expect(snapshot.agentStates[agentId].lastDispatchedTaskId).toBeUndefined();
    subscription.dispose();
  });

  it('contains a failing settlement hook instead of leaving a floating rejection', async () => {
    const { registry, agentId } = buildSingleAgentFixtureRegistry();
    const transport = new LocalAdapter(registry, async () => {
      throw new Error('settlement store unavailable');
    });
    const taskId = newTaskId();
    await transport.dispatch({
      taskId,
      tenantId: randomUUID(),
      agentId,
      agentCardVersion: '0.0.1',
      requirements: { business_name: 'Sazón Andino' },
      createdAt: new Date().toISOString(),
    });

    await expect(transport.waitForSettlement(taskId)).resolves.toMatchObject({ status: 'completed' });
    await expect(transport.getResult(taskId)).resolves.toMatchObject({ status: 'completed' });
    await expect(transport.waitForSettlement(newTaskId())).rejects.toThrow(/never dispatched/);
  });

  it.each([
    ['content_policy', 'content_policy', ['iterate', 'retry']],
    ['rate_limited', 'transient', ['retry']],
    ['usage_limited', 'transient', ['retry']],
    ['config_missing', 'permanent_bug', ['retry']],
    ['something_new', 'permanent_bug', ['retry']],
  ] as const)(
    'persists a failed task with kind %s as error_category %s; recovery offered: %j (KAN-58, KAN-64)',
    async (kind, expectedCategory, expectedAllowed) => {
      const { core, agentId, workflow } = buildControlledHarness();
      const recordSettlement = vi.spyOn(workflow, 'recordSettlement');
      const conversationId = randomUUID();
      await core.startConversation(conversationId, randomUUID(), randomUUID());
      await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
      const taskId = await issueGenerate(core, conversationId, agentId);

      await core.onTaskSettled(taskId, {
        status: 'failed',
        result: {
          status: 'failed',
          taskId,
          error: { kind, message: 'synthetic failure' },
          completedAt: new Date().toISOString() as `${string}T${string}Z`,
        },
      });

      expect(recordSettlement).toHaveBeenCalledWith(expect.objectContaining({
        taskId,
        status: 'failed',
        error: { kind, message: 'synthetic failure' },
        errorCategory: expectedCategory,
      }));
      const [view] = await core.getDeliverableStates(conversationId);
      expect(view).toMatchObject({
        state: 'failed',
        lastFailure: { taskId, errorCategory: expectedCategory, errorKind: kind, retryable: expectedCategory === 'transient' },
        allowedCommands: expectedAllowed,
      });
    },
  );

  it('does not retain failed settlements: nothing is announced and nothing stays queued', async () => {
    const { core, messages, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    const taskId = await issueGenerate(core, conversationId, agentId);
    expect(messages[0].taskId).toBe(taskId);
    await core.getNextDecision(conversationId); // acknowledge the dispatch

    await core.onTaskSettled(taskId, {
      status: 'failed',
      result: {
        status: 'failed',
        taskId,
        error: { kind: 'timeout', message: 'synthetic timeout' },
        completedAt: new Date().toISOString() as `${string}T${string}Z`,
      },
    });

    const plan = await core.peekNextDecision(conversationId);
    expect(plan.some((d) => d.kind === 'announce_completion' || d.kind === 'announce_dispatch')).toBe(false);
    // The failure is not buffered in memory, so it cannot leak across turns.
    expect(core['pendingCompletions'].size).toBe(0);
    const snapshot = await core.getSnapshot(conversationId);
    expect(snapshot.agentStates[agentId].lastDispatchedTaskId).toBeUndefined();
  });
});

/**
 * KAN-55: each dispatch/completion announcement reaches exactly one chat turn.
 * `runTurn` mirrors app/actions/chat.ts: apply the delta, peek the plan,
 * durably checkpoint it (here: record it), then acknowledge that exact plan.
 * The confirmation pre-read is a peek, which must never consume or dispatch.
 *
 * KAN-28: the confirming turn no longer dispatches; it offers «Generar». The
 * dispatch happens when the user presses the button between turns, and the
 * next turn announces it.
 */
describe('announcement delivery per turn (KAN-55)', () => {
  type Core = OrchestratorCoreImpl;
  interface TurnHooks {
    /** Runs after applyDelta and before the controller peeks the plan. */
    readonly beforePeek?: () => Promise<void>;
    /** Runs after the peek and before the checkpoint/acknowledgement. */
    readonly beforeAcknowledge?: () => Promise<void>;
  }

  async function runTurn(core: Core, delta: FieldDelta, hooks: TurnHooks = {}) {
    await core.applyDelta(delta);
    await hooks.beforePeek?.();
    const decisions = await core.peekNextDecision(delta.conversationId);
    await hooks.beforeAcknowledge?.();
    const checkpointed = structuredClone(decisions);
    await core.acknowledgeDecisions(delta.conversationId, checkpointed);
    return checkpointed;
  }

  function announcementsOf(decisions: ReadonlyArray<PlannerDecision>): string[] {
    return decisions.flatMap((decision) =>
      decision.kind === 'announce_dispatch' || decision.kind === 'announce_completion'
        ? [`${decision.kind}:${decision.taskId}`]
        : [],
    );
  }

  function hedgedNameDelta(conversationId: string, agentId: string): FieldDelta {
    return buildDelta({
      conversationId,
      source: 'test-chat',
      fields: {
        [agentId]: {
          business_name: {
            value: 'Sazón Andino',
            confidence: CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM,
          },
          business_profile: { value: 'Comida peruana', confidence: 1 },
        },
      },
    });
  }

  /** Same shape as the Extractor's affirmation fast path. */
  function affirmationDelta(conversationId: string, agentId: string, pendingValue: unknown): FieldDelta {
    return buildDelta({
      conversationId,
      source: 'test-chat',
      fields: { [agentId]: { business_name: { value: pendingValue, confidence: 1, rawInput: 'sí' } } },
    });
  }

  function emptyDelta(conversationId: string): FieldDelta {
    return buildDelta({ conversationId, source: 'test-chat', fields: {} });
  }

  function completedState(taskId: string): TaskState {
    return {
      status: 'completed',
      result: {
        status: 'completed',
        taskId,
        artifacts: [{ kind: 'text', inline: { value: 'logo' } }],
        completedAt: new Date().toISOString() as `${string}T${string}Z`,
      },
    };
  }

  /** Turn 1 asks to confirm a hedged value; returns the persisted confirm_field. */
  async function reachConfirmation(core: Core, conversationId: string, agentId: string) {
    const turn1 = await runTurn(core, hedgedNameDelta(conversationId, agentId));
    expect(turn1).toEqual([
      expect.objectContaining({ kind: 'confirm_field', agentId, fieldName: 'business_name' }),
    ]);
    const confirm = turn1[0];
    if (confirm.kind !== 'confirm_field') throw new Error('expected confirm_field');
    return confirm;
  }

  it('synchronous completion: confirmation pre-reads do not consume or dispatch; the confirming turn offers Generar; the next turn announces both once', async () => {
    const { core, transport, agentId } = buildHarness();
    const dispatchSpy = vi.spyOn(transport, 'dispatch');
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());

    const confirm = await reachConfirmation(core, conversationId, agentId);
    // Pre-reads of the confirmation are idempotent and side-effect free.
    expect(await core.peekNextDecision(conversationId)).toEqual([confirm]);
    expect(await core.peekNextDecision(conversationId)).toEqual([confirm]);
    expect(dispatchSpy).not.toHaveBeenCalled();

    const turn2 = await runTurn(core, affirmationDelta(conversationId, agentId, confirm.pendingValue));
    expect(turn2).toEqual([{ kind: 'offer_generation', agentId, deliverableKind: agentId }]);
    expect(dispatchSpy).not.toHaveBeenCalled();

    // «Generar»; the task settles before the next turn reads the plan.
    const taskId = await issueGenerate(core, conversationId, agentId);
    await transport.waitForSettlement(taskId);
    const turn3 = await runTurn(core, emptyDelta(conversationId));
    expect(announcementsOf(turn3)).toEqual([
      `announce_dispatch:${taskId}`,
      `announce_completion:${taskId}`,
    ]);

    // Next turn's pre-read and the turn itself see neither announcement again.
    expect(announcementsOf(await core.peekNextDecision(conversationId))).toEqual([]);
    expect(announcementsOf(await runTurn(core, emptyDelta(conversationId)))).toEqual([]);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('asynchronous completion between turns: dispatch is announced by the turn after Generar, completion by the next turn, each once', async () => {
    const { core, messages, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());

    const confirm = await reachConfirmation(core, conversationId, agentId);
    await runTurn(core, affirmationDelta(conversationId, agentId, confirm.pendingValue));
    expect(messages).toHaveLength(0);
    const taskId = await issueGenerate(core, conversationId, agentId);
    expect(messages).toHaveLength(1);
    const turn2 = await runTurn(core, emptyDelta(conversationId));
    expect(announcementsOf(turn2)).toEqual([`announce_dispatch:${taskId}`]);

    // Pre-read before the worker settles: nothing left to announce.
    expect(announcementsOf(await core.peekNextDecision(conversationId))).toEqual([]);

    await core.onTaskSettled(taskId, completedState(taskId));
    // Repeated pre-reads keep the completion queued.
    expect(announcementsOf(await core.peekNextDecision(conversationId))).toEqual([
      `announce_completion:${taskId}`,
    ]);
    expect(announcementsOf(await core.peekNextDecision(conversationId))).toEqual([
      `announce_completion:${taskId}`,
    ]);

    expect(announcementsOf(await runTurn(core, emptyDelta(conversationId)))).toEqual([
      `announce_completion:${taskId}`,
    ]);
    expect(announcementsOf(await runTurn(core, emptyDelta(conversationId)))).toEqual([]);
    expect(messages).toHaveLength(1);
  });

  it('asynchronous completion during a turn: it is not acknowledged with the dispatch and reaches the next turn once', async () => {
    const { core, messages, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());

    const confirm = await reachConfirmation(core, conversationId, agentId);
    await runTurn(core, affirmationDelta(conversationId, agentId, confirm.pendingValue));
    const taskId = await issueGenerate(core, conversationId, agentId);
    const turn2 = await runTurn(core, emptyDelta(conversationId), {
      // The worker settles after the controller peeked but before it checkpointed.
      beforeAcknowledge: async () => {
        await core.onTaskSettled(messages[0].taskId, completedState(messages[0].taskId));
      },
    });
    expect(announcementsOf(turn2)).toEqual([`announce_dispatch:${taskId}`]);

    expect(announcementsOf(await runTurn(core, emptyDelta(conversationId)))).toEqual([
      `announce_completion:${taskId}`,
    ]);
    expect(announcementsOf(await runTurn(core, emptyDelta(conversationId)))).toEqual([]);
    expect(messages).toHaveLength(1);
  });

  it('asynchronous completion with store I/O lands in exactly one turn', async () => {
    const { core, transport, agentId } = buildHarness({ simulatedIo: true });
    const dispatchSpy = vi.spyOn(transport, 'dispatch');
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());

    const confirm = await reachConfirmation(core, conversationId, agentId);
    await runTurn(core, affirmationDelta(conversationId, agentId, confirm.pendingValue));
    expect(dispatchSpy).not.toHaveBeenCalled();
    const taskId = await issueGenerate(core, conversationId, agentId);
    const turn2 = await runTurn(core, emptyDelta(conversationId));
    await transport.waitForSettlement(taskId);
    const turn3 = await runTurn(core, emptyDelta(conversationId));
    const turn4 = await runTurn(core, emptyDelta(conversationId));

    // Whichever turn the completion races into, the union is exactly one of each.
    const delivered = [...turn2, ...turn3, ...turn4].flatMap((d) => announcementsOf([d]));
    expect(delivered.sort()).toEqual(
      [`announce_completion:${taskId}`, `announce_dispatch:${taskId}`].sort(),
    );
    expect(announcementsOf(turn2)).toContain(`announce_dispatch:${taskId}`);
    expect(announcementsOf(turn4)).toEqual([]);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
