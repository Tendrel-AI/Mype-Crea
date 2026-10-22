import { describe, expect, it } from 'vitest';
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
  type PlannerDecision,
} from '../contracts';
import { buildDelta, buildSingleAgentFixtureRegistry } from './_fixtures';
import type { A2AMessage, IAgentTransport, TaskState } from '../agent-types';

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
  });
  return { core, messages, notifier, agentId, registry, store };
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

    // 3. Submit business_profile -> all required fields filled -> dispatch.
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
      // deliverableIds is only populated when `deliverablesFor` is wired
      // (production path). The in-memory smoke harness skips persistence,
      // so the array is empty — the assertion below is just a presence
      // check to keep the contract shape covered.
      expect(Array.isArray(completion.deliverableIds)).toBe(true);
      // The fixture echo handler returns one artifact per filled requirement;
      // those artifacts must reach the decision so the Responder can present
      // them inline.
      expect(completion.artifacts.length).toBeGreaterThan(0);
    }

    // 4. The snapshot reflects the filled slots and the dispatch lifecycle.
    // After settle, lastDispatchedTaskId is cleared (so the planner's Rule 1
    // doesn't keep firing on a settled task); iterationCount stays at 1 so
    // findAgentReadyToDispatch knows this agent has already been handled.
    const snapshot = await core.getSnapshot(conversationId);
    const state = snapshot.agentStates[agentId];
    expect(state.requiredFields.business_name.status).toBe('filled');
    expect(state.requiredFields.business_profile.status).toBe('filled');
    expect(state.lastDispatchedTaskId).toBeUndefined();
    expect(state.iterationCount).toBe(1);

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

    const snapshotA = await first.core.getSnapshot(conversationA);
    const snapshotB = await second.core.getSnapshot(conversationB);
    const stateA = snapshotA.agentStates[first.agentId];
    const stateB = snapshotB.agentStates[second.agentId];
    expect(stateA.requiredFields).toEqual(stateB.requiredFields);
    expect(stateA.optionalFields).toEqual(stateB.optionalFields);
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

  it('does not redispatch while a ready agent is in flight or after it settles', async () => {
    const { core, messages, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    const taskId = messages[0].taskId;

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

    const dispatchPlan = await core.getNextDecision(conversationId);
    expect(dispatchPlan.some((decision) => decision.kind === 'announce_dispatch')).toBe(true);
  });

  it('keeps settled completion available to the caller after onTaskSettled internal planning', async () => {
    const { core, messages, agentId } = buildControlledHarness();
    const conversationId = randomUUID();
    await core.startConversation(conversationId, randomUUID(), randomUUID());
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    const taskId = messages[0].taskId;
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
    const { core, messages, agentId, registry, store } = buildControlledHarness();
    const conversationId = randomUUID();
    const tenantId = randomUUID();
    const userId = randomUUID();
    await core.startConversation(conversationId, tenantId, userId);
    await core.applyDelta(readyDelta(conversationId, agentId, 'test-form'));
    const taskId = messages[0].taskId;

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
});

