/**
 * MYPES Platform — Redis Pub/Sub agent transport
 * ===============================================
 *
 * Location: src/transport/redis-queue-adapter.ts
 *
 * Phase-1 implementation of IAgentTransport that satisfies architecture §2.5:
 * Postgres is the single source of truth for task state, Redis Pub/Sub is the
 * wake-up channel that tells a worker "go look at the agent_tasks row with
 * this id." The notification carries only routing metadata (`taskId`,
 * `tenantId`, `agentId`); subscribers re-read the canonical row from
 * Postgres and never trust the payload.
 *
 * Channel naming: `mypes:agent_task:dispatch:<agentId>`. One channel per
 * agent so each worker subscribes only to its own queue and ioredis filters
 * the rest. Subscribers can fan out by registering multiple agent workers.
 *
 * Routing: agents listed in `redisAgents` are dispatched via Pub/Sub. Any
 * other agent falls through to `fallback` (a LocalAdapter), which keeps the
 * non-Redis agents (`tagline`, `label`, `social`) running until they are
 * migrated. When `redisAgents` is exhaustive, `fallback` is never invoked.
 *
 * Result delivery: NOT this adapter's responsibility. Workers run handlers
 * out-of-band and call OrchestratorCoreImpl.onTaskSettled directly (same
 * shape as LocalAdapter's settle callback). `getResult()` is here only to
 * satisfy the interface; the orchestrator never polls it.
 *
 * Failure mode: a Redis publish that fails after the agent_tasks row is
 * already committed leaves the row stranded as `pending`. Recovery is the
 * sweeper's job (§2.5); this adapter logs and surfaces the error so the
 * orchestrator's caller can retry if it wants to.
 */
import type { Redis as RedisClient } from 'ioredis';
import type { AgentId, TaskId } from '../core/contracts';
import type {
  A2AMessage,
  IAgentTransport,
  TaskState,
} from '../core/agent-types';
import {
  notification,
  redisChannelFor,
  redisChannelName,
  serializeNotification,
  type NotificationPayload,
} from '../core/contracts/notifications';
import { loggerFor } from '../services/logger';

const log = loggerFor('transport.redis-queue');

export const channelForAgent = (agentId: AgentId): string => redisChannelName('task_dispatch', agentId);

/**
 * Payload published on the wake-up channel (the `task_dispatch` kind of the
 * notification contract). Trigger only — never trusted.
 */
export type DispatchNotification = NotificationPayload<'task_dispatch'>;

/** The wire message for a dispatch wake-up. Every publisher goes through this. */
export function dispatchWakeUp(payload: DispatchNotification): { readonly channel: string; readonly message: string } {
  const n = notification('task_dispatch', payload);
  return { channel: redisChannelFor(n), message: serializeNotification(n) };
}

export interface RedisQueueAdapterDeps {
  readonly publisher: RedisClient;
  /** Agents whose dispatches go via Redis Pub/Sub. Anything else falls back. */
  readonly redisAgents: ReadonlySet<AgentId>;
  /** Transport used for any agentId not in `redisAgents`. */
  readonly fallback?: IAgentTransport;
}

export class RedisQueueAdapter implements IAgentTransport {
  constructor(private readonly deps: RedisQueueAdapterDeps) {}

  async dispatch(message: A2AMessage): Promise<{ taskId: TaskId }> {
    if (!this.deps.redisAgents.has(message.agentId)) {
      if (!this.deps.fallback) {
        throw new Error(
          `RedisQueueAdapter: no fallback transport for agent ${message.agentId}`,
        );
      }
      return this.deps.fallback.dispatch(message);
    }

    const { channel, message: body } = dispatchWakeUp({
      taskId: message.taskId,
      tenantId: message.tenantId,
      agentId: message.agentId,
    });

    const subscribers = await this.deps.publisher.publish(channel, body);

    log.info(
      {
        op: 'dispatch',
        channel,
        taskId: message.taskId,
        agentId: message.agentId,
        subscribers,
      },
      'transport.redis-queue.published',
    );

    if (subscribers === 0) {
      log.warn(
        { channel, taskId: message.taskId },
        'transport.redis-queue.no_subscribers',
      );
    }

    return { taskId: message.taskId };
  }

  async getResult(taskId: TaskId): Promise<TaskState> {
    if (this.deps.fallback) return this.deps.fallback.getResult(taskId);
    log.debug(
      { taskId },
      'transport.redis-queue.getResult.no_fallback_returning_pending',
    );
    return { status: 'pending' };
  }
}
