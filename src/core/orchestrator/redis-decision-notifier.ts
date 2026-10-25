/**
 * Redis Pub/Sub-backed IDecisionNotifier (channel `mypes:decision:<conversationId>`).
 *
 * Per architecture §2.5 the wake-up notification "carries only the task or
 * decision ID" and subscribers re-read the authoritative row from Postgres.
 * For Phase 1 this notifier publishes the full PlannerDecision (the
 * `decision` kind of the notification contract) as a transitional shape.
 *
 * TODO(arch §2.5): once decisions are persisted (an `agent_decisions` table
 * or equivalent), publish only `{ conversationId, decisionId }` here and
 * have subscribers re-read.
 *
 * Wire handling (serialize, parse, reject, scope check) lives in
 * `RedisNotificationChannel`. Publish errors are logged, never thrown.
 */
import type { Redis as RedisClient } from 'ioredis';
import { ChannelDecisionNotifier } from './orchestrator-core';
import { RedisNotificationChannel } from './notification-channels';

export class RedisDecisionNotifier extends ChannelDecisionNotifier {
  constructor(publisher: RedisClient, subscriber: RedisClient) {
    super(new RedisNotificationChannel('decision', publisher, subscriber));
  }
}
