import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InProcessDecisionNotifier,
  OrchestratorCoreImpl,
} from '../orchestrator/orchestrator-core';
import { InMemoryConversationStore } from '../orchestrator/in-memory-store';
import { buildDefaultRegistry } from '../orchestrator/bootstrap-registry';
import { LocalAdapter } from '../../transport/local-adapter';
import { newTaskId } from '../ids';
import type { FieldDelta, PlannerDecision } from '../contracts';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function buildHarness() {
  const registry = buildDefaultRegistry();
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

  return { core, store, registry, transport, notifier };
}

describe('orchestrator smoke (Phase A)', () => {
  it('drives name-agent end-to-end via FieldDelta -> dispatch -> announce_completion', async () => {
    const { core, notifier } = buildHarness();
    const conversationId = randomUUID();
    const tenantId = randomUUID();

    // Capture every decision the orchestrator emits — completions are
    // surfaced through the notifier (exactly once each), not by polling.
    const observed: PlannerDecision[] = [];
    const subscription = notifier.subscribe(conversationId, (d) => {
      observed.push(d);
    });

    await core.startConversation(conversationId, tenantId, randomUUID());

    // 1. With nothing filled, the planner asks for name-agent's first
    //    required field (business_name).
    const decisionEmpty = await core.getNextDecision(conversationId);
    expect(decisionEmpty).toEqual({
      kind: 'request_field',
      agentId: 'name-agent',
      fieldName: 'business_name',
      promptHint: expect.any(String),
    });

    // 2. Submit business_name with form-grade confidence.
    const deltaName: FieldDelta = {
      conversationId,
      source: 'test-form',
      timestamp: new Date().toISOString(),
      fields: {
        'name-agent': {
          business_name: { value: 'Sazón Andino', confidence: 1.0 },
        },
      },
    };
    await core.applyDelta(deltaName);

    const decisionAfterName = await core.getNextDecision(conversationId);
    expect(decisionAfterName).toMatchObject({
      kind: 'request_field',
      agentId: 'name-agent',
      fieldName: 'business_profile',
    });

    // 3. Submit business_profile -> all required fields filled -> dispatch.
    const deltaProfile: FieldDelta = {
      conversationId,
      source: 'test-form',
      timestamp: new Date().toISOString(),
      fields: {
        'name-agent': {
          business_profile: {
            value: 'Comida tradicional peruana lista para llevar.',
            confidence: 1.0,
          },
        },
      },
    };
    await core.applyDelta(deltaProfile);

    // Let the LocalAdapter's queued microtask run the handler and forward
    // the completion through core.onTaskSettled into the notifier.
    await flushMicrotasks();

    const dispatchAnnouncement = observed.find((d) => d.kind === 'announce_dispatch');
    expect(dispatchAnnouncement).toMatchObject({
      kind: 'announce_dispatch',
      agentId: 'name-agent',
    });

    const completion = observed.find((d) => d.kind === 'announce_completion');
    expect(completion).toBeDefined();
    if (completion?.kind === 'announce_completion') {
      expect(completion.agentId).toBe('name-agent');
      expect(completion.deliverableIds.length).toBeGreaterThan(0);
    }

    // 4. The snapshot reflects the filled slots and the dispatched task.
    const snapshot = await core.getSnapshot(conversationId);
    const nameState = snapshot.agentStates['name-agent'];
    expect(nameState.requiredFields.business_name.status).toBe('filled');
    expect(nameState.requiredFields.business_profile.status).toBe('filled');
    expect(nameState.lastDispatchedTaskId).toBeDefined();
    expect(nameState.iterationCount).toBe(1);

    subscription.dispose();
  });

  it('treats < STORE_AND_CONFIRM confidence values as discarded', async () => {
    const { core } = buildHarness();
    const conversationId = randomUUID();
    const tenantId = randomUUID();

    await core.startConversation(conversationId, tenantId, randomUUID());

    await core.applyDelta({
      conversationId,
      source: 'test-chat',
      timestamp: new Date().toISOString(),
      fields: {
        'name-agent': {
          business_name: { value: 'maybe a name?', confidence: 0.4 },
        },
      },
    });

    const decision = await core.getNextDecision(conversationId);
    expect(decision).toMatchObject({
      kind: 'request_field',
      agentId: 'name-agent',
      fieldName: 'business_name',
    });

    const snapshot = await core.getSnapshot(conversationId);
    expect(snapshot.agentStates['name-agent'].requiredFields.business_name.status).toBe(
      'empty',
    );
  });

  it('stores STORE_AND_CONFIRM-range values as pending_confirmation', async () => {
    const { core } = buildHarness();
    const conversationId = randomUUID();
    const tenantId = randomUUID();

    await core.startConversation(conversationId, tenantId, randomUUID());

    await core.applyDelta({
      conversationId,
      source: 'test-chat',
      timestamp: new Date().toISOString(),
      fields: {
        'name-agent': {
          business_name: { value: 'Sazón Andino', confidence: 0.7 },
        },
      },
    });

    const decision = await core.getNextDecision(conversationId);
    expect(decision).toMatchObject({
      kind: 'confirm_field',
      agentId: 'name-agent',
      fieldName: 'business_name',
      pendingValue: 'Sazón Andino',
      reason: 'low_confidence',
    });
  });
});
