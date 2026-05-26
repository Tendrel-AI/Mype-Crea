import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InProcessDecisionNotifier,
  OrchestratorCoreImpl,
} from '../orchestrator/orchestrator-core';
import { InMemoryConversationStore } from '../orchestrator/in-memory-store';
import { LocalAdapter } from '../../transport/local-adapter';
import { newTaskId } from '../ids';
import type { PlannerDecision } from '../contracts';
import { buildDelta, buildSingleAgentFixtureRegistry } from './_fixtures';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function buildHarness() {
  const { registry, agentId } = buildSingleAgentFixtureRegistry();
  const store = new InMemoryConversationStore(registry.getFieldSchemas());

  let coreRef: OrchestratorCoreImpl | null = null;
  const transport = new LocalAdapter(registry, (taskId, state) => {
    void coreRef?.onTaskSettled(taskId, state);
  });

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

describe('orchestrator smoke (agent-agnostic)', () => {
  it('drives a fixture agent end-to-end via FieldDelta -> dispatch -> announce_completion', async () => {
    const { core, notifier, agentId } = buildHarness();
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

    await flushMicrotasks();

    const dispatchAnnouncement = observed.find((d) => d.kind === 'announce_dispatch');
    expect(dispatchAnnouncement).toMatchObject({
      kind: 'announce_dispatch',
      agentId,
    });

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
});
