/**
 * Redis Pub/Sub-backed IAgentLifecycleNotifier
 * (channel `mypes:lifecycle:processing:<conversationId>`).
 *
 * Wire handling (serialize, parse, reject, scope check) lives in
 * `RedisNotificationChannel` over the notification contract. One channel per
 * (event-kind, conversation) keeps every subscriber narrow.
 */
import type { Redis as RedisClient } from 'ioredis';
import { ChannelAgentLifecycleNotifier } from './agent-lifecycle-notifier';
import { RedisNotificationChannel } from './notification-channels';

export class RedisAgentLifecycleNotifier extends ChannelAgentLifecycleNotifier {
  constructor(publisher: RedisClient, subscriber: RedisClient) {
    super(new RedisNotificationChannel('task_processing', publisher, subscriber));
  }
}
