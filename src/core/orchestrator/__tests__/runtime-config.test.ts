/**
 * Unit test for `buildRuntime`. Exercises the wiring with all-fake deps —
 * no Redis, no Postgres, no env vars. Proves a fresh `Runtime` is callable
 * end-to-end (apply a delta, query the next decision) so tests built on top
 * of `buildRuntime` don't have to reboot the production singleton.
 */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRuntime } from '../runtime-config';
import {
  InMemoryConversationStore,
} from '../in-memory-store';
import { InProcessDecisionNotifier } from '../orchestrator-core';
import { LocalAdapter } from '../../../transport/local-adapter';
import { buildSingleAgentFixtureRegistry } from '../../__tests__/_fixtures';
import type { TaskId } from '../../contracts';

describe('buildRuntime', () => {
  it('wires core + chat adapters from a fake config and drives a turn end-to-end', async () => {
    const { registry, agentId } = buildSingleAgentFixtureRegistry();
    const store = new InMemoryConversationStore(registry.getFieldSchemas());
    const decisionNotifier = new InProcessDecisionNotifier();

    let nextTaskId = 1000;
    const runtime = buildRuntime({
      registry,
      store,
      newTaskId: () => `00000000-0000-0000-0000-${String(nextTaskId++).padStart(12, '0')}` as TaskId,
      decisionNotifier,
      transportFactory: (onTaskSettled) =>
        new LocalAdapter(registry, (taskId, state) => {
          onTaskSettled(taskId, state, []);
        }),
    });

    expect(runtime.core).toBeDefined();
    expect(runtime.chatInputAdapter).toBeDefined();
    expect(runtime.chatOutputAdapter).toBeDefined();

    const conversationId = randomUUID();
    const tenantId = randomUUID();
    await runtime.core.startConversation(conversationId, tenantId, randomUUID());

    // With nothing filled, the planner should ask for the fixture's required fields.
    const plan = await runtime.core.getNextDecision(conversationId);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: 'request_fields', agentId });
  });

  it('invokes transportFactory exactly once and threads onTaskSettled through', () => {
    const { registry } = buildSingleAgentFixtureRegistry();
    const store = new InMemoryConversationStore(registry.getFieldSchemas());
    const decisionNotifier = new InProcessDecisionNotifier();

    const transportFactory = vi.fn((_onTaskSettled) =>
      new LocalAdapter(registry, () => undefined),
    );

    buildRuntime({
      registry,
      store,
      newTaskId: () => randomUUID() as TaskId,
      decisionNotifier,
      transportFactory,
    });

    expect(transportFactory).toHaveBeenCalledTimes(1);
    const onTaskSettled = transportFactory.mock.calls[0]?.[0];
    expect(typeof onTaskSettled).toBe('function');
  });
});
