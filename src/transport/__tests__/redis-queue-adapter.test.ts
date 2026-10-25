/**
 * Unit tests for RedisQueueAdapter — the IAgentTransport that publishes
 * task wake-up notifications to Redis Pub/Sub instead of running the
 * handler in-process.
 *
 * Uses a tiny FakePublisher (just enough surface to satisfy the adapter)
 * so the test does not need a live Redis. The fake records every channel
 * + payload pair so we can assert what was published.
 */
import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_CONTRACT_VERSION, parseNotification } from '../../core/contracts/notifications';
import type { Redis as RedisClient } from 'ioredis';
import {
  RedisQueueAdapter,
  channelForAgent,
} from '../redis-queue-adapter';
import type { A2AMessage, IAgentTransport, TaskState } from '../../core/agent-types';
import type { AgentId, TaskId, UUID } from '../../core/contracts';

class FakePublisher {
  readonly published: Array<{ channel: string; payload: string }> = [];
  subscriberCount = 1;

  async publish(channel: string, payload: string): Promise<number> {
    this.published.push({ channel, payload });
    return this.subscriberCount;
  }
}

const asRedis = (fp: FakePublisher): RedisClient => fp as unknown as RedisClient;

function buildMessage(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    taskId: '11111111-1111-1111-1111-111111111111' as TaskId,
    tenantId: '22222222-2222-2222-2222-222222222222' as UUID,
    agentId: 'logo-agent' as AgentId,
    agentCardVersion: '0.1.0',
    requirements: { business_name: 'Sazón Andino', style_keywords: 'minimalista' },
    createdAt: new Date('2026-05-04T00:00:00Z').toISOString(),
    ...overrides,
  };
}

describe('RedisQueueAdapter', () => {
  it('publishes a wake-up notification on the per-agent channel for redisAgents', async () => {
    const publisher = new FakePublisher();
    const adapter = new RedisQueueAdapter({
      publisher: asRedis(publisher),
      redisAgents: new Set(['logo-agent' as AgentId]),
    });

    const message = buildMessage();
    const { taskId } = await adapter.dispatch(message);

    expect(taskId).toBe(message.taskId);
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0].channel).toBe(
      channelForAgent('logo-agent' as AgentId),
    );

    const payload = JSON.parse(publisher.published[0].payload);
    expect(payload).toEqual({
      v: NOTIFICATION_CONTRACT_VERSION,
      kind: 'task_dispatch',
      taskId: message.taskId,
      tenantId: message.tenantId,
      agentId: 'logo-agent',
    });
    // The worker reads it back through the same contract.
    expect(parseNotification(publisher.published[0].payload, ['task_dispatch'])).toMatchObject({ ok: true });
    // Notification must be a trigger only — no requirements payload leaks through.
    expect(payload).not.toHaveProperty('requirements');
  });

  it('routes through the fallback transport for agents not in redisAgents', async () => {
    const publisher = new FakePublisher();
    const fallbackDispatch = vi.fn(async (m: A2AMessage) => ({ taskId: m.taskId }));
    const fallback: IAgentTransport = {
      dispatch: fallbackDispatch,
      getResult: async (): Promise<TaskState> => ({ status: 'pending' }),
    };

    const adapter = new RedisQueueAdapter({
      publisher: asRedis(publisher),
      redisAgents: new Set(['logo-agent' as AgentId]),
      fallback,
    });

    const message = buildMessage({ agentId: 'tagline-agent' as AgentId });
    await adapter.dispatch(message);

    expect(publisher.published).toHaveLength(0);
    expect(fallbackDispatch).toHaveBeenCalledWith(message);
  });

  it('throws when no fallback is configured for a non-Redis agent', async () => {
    const publisher = new FakePublisher();
    const adapter = new RedisQueueAdapter({
      publisher: asRedis(publisher),
      redisAgents: new Set(['logo-agent' as AgentId]),
    });

    await expect(
      adapter.dispatch(buildMessage({ agentId: 'tagline-agent' as AgentId })),
    ).rejects.toThrow(/no fallback transport/);
  });

  it('still resolves the dispatch when no subscribers are connected (logs only)', async () => {
    const publisher = new FakePublisher();
    publisher.subscriberCount = 0;
    const adapter = new RedisQueueAdapter({
      publisher: asRedis(publisher),
      redisAgents: new Set(['logo-agent' as AgentId]),
    });

    const result = await adapter.dispatch(buildMessage());
    expect(result.taskId).toBeDefined();
    expect(publisher.published).toHaveLength(1);
  });
});
