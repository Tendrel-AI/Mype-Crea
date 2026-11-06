/**
 * Redis Pub/Sub-backed IArtifactNotifier (channel `mypes:artifact:<conversationId>`).
 *
 * Wire handling (serialize, parse, reject, scope check) lives in
 * `RedisNotificationChannel` over the notification contract.
 *
 * TODO(arch §2.5): once deliverables are surfaced through a repo read path,
 * publish only `{ conversationId, taskId }` and have subscribers re-read.
 */
import type { Redis as RedisClient } from 'ioredis';
import { ChannelArtifactNotifier } from './artifact-notifier';
import { RedisNotificationChannel } from './notification-channels';

export class RedisArtifactNotifier extends ChannelArtifactNotifier {
  constructor(publisher: RedisClient, subscriber: RedisClient) {
    super(new RedisNotificationChannel('artifact_published', publisher, subscriber));
  }
}
