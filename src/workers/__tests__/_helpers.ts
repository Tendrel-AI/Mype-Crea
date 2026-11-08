/**
 * Shared helpers for per-agent worker tests.
 *
 * Each worker (logo, tagline, label, social) drains a Redis dispatch channel,
 * claims an agent_tasks row, runs its handler, and reports back. The plumbing
 * is identical; only the channel name and handler differ. These helpers
 * cover the plumbing so per-worker tests assert only handler-specific
 * behavior.
 */
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { Redis as RedisClient } from 'ioredis';
import { AgentRegistry } from '../../core/orchestrator/agent-registry';
import type { AgentTaskRow } from '../../repos/models';
import type { TaskId, UUID } from '../../core/contracts';
import type { WorkerContext } from '../_kit';

/** Stand-in for an ioredis subscriber: pushes messages via `emitMessage`. */
export class FakeSubscriber extends EventEmitter {
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];

  async subscribe(channel: string): Promise<number> {
    this.subscribed.push(channel);
    return 1;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.unsubscribed.push(channel);
    return 1;
  }

  emitMessage(channel: string, payload: string): void {
    this.emit('message', channel, payload);
  }
}

export const asRedisClient = (s: FakeSubscriber): RedisClient =>
  s as unknown as RedisClient;

/** Lets test code drive the message-handling chain to completion. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const DEFAULT_TASK_ID = '33333333-3333-3333-3333-333333333333' as TaskId;
const DEFAULT_CONVERSATION_ID = '44444444-4444-4444-4444-444444444444' as UUID;
const DEFAULT_IDEMPOTENCY_KEY = '55555555-5555-5555-5555-555555555555' as UUID;

export function buildAgentTaskRow(
  overrides: Partial<AgentTaskRow> = {},
): AgentTaskRow {
  const id = overrides.id ?? DEFAULT_TASK_ID;
  return {
    id,
    conversationId: DEFAULT_CONVERSATION_ID,
    agentId: 'logo-agent',
    agentCardVersion: '0.1.0',
    status: 'in_progress',
    attempts: 1,
    idempotencyKey: DEFAULT_IDEMPOTENCY_KEY,
    parentTaskId: null,
    iterationRootId: id,
    iterationNumber: 1,
    iterationTrigger: null,
    requirementsSnapshot: {
      business_name: 'Sazón Andino',
      style_keywords: 'minimalista',
    },
    error: null,
    errorCategory: null,
    scheduledFor: '2026-05-04T00:00:00Z',
    dispatchedAt: '2026-05-04T00:00:00Z',
    completedAt: null,
    lastAttemptAt: '2026-05-04T00:00:00Z',
    createdAt: '2026-05-04T00:00:00Z',
    ...overrides,
  };
}

export type WorkerTestOverrides = Omit<Partial<WorkerContext>, 'subscriber'> & {
  /** Pass a `FakeSubscriber` (or any compatible event emitter); it'll be cast to `RedisClient`. */
  readonly subscriber?: FakeSubscriber;
};

/**
 * Build a WorkerContext with sensible defaults. Override individual fields
 * by passing them in `overrides`. The subscriber defaults to a fresh
 * `FakeSubscriber`; the registry defaults to an empty `AgentRegistry`.
 */
export function buildWorkerTestContext(
  overrides: WorkerTestOverrides = {},
): WorkerContext {
  const subscriber = overrides.subscriber ?? new FakeSubscriber();
  return {
    subscriber: asRedisClient(subscriber),
    registry: overrides.registry ?? new AgentRegistry(),
    systemReposFor:
      overrides.systemReposFor ??
      (() =>
        ({
          agentTasks: { findById: vi.fn(), claimById: vi.fn() } as never,
          llmCalls: {} as never,
        })),
    resolveConversationOwner:
      overrides.resolveConversationOwner ?? vi.fn(async () => '22222222-2222-2222-2222-222222222222' as UUID),
    onTaskSettled: overrides.onTaskSettled ?? vi.fn(),
    pinnedPromptFor: overrides.pinnedPromptFor,
    deliverablesFor: overrides.deliverablesFor,
    settleTaskFor: overrides.settleTaskFor,
    // Storage disabled by default (artifacts pass through unchanged); KAN-52 tests inject a fake.
    storeArtifacts: overrides.storeArtifacts ?? (async ({ artifacts }) => artifacts),
    lifecycleNotifier: overrides.lifecycleNotifier,
  };
}
