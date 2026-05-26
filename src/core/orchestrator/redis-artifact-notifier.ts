/**
 * Redis Pub/Sub-backed IArtifactNotifier.
 *
 * Channel: `mypes:artifact:<conversationId>`.
 *
 * Mirrors the structure of RedisDecisionNotifier — see that file for the
 * architectural notes (§2.5 wake-up channel, transitional payload shape,
 * best-effort failure handling).
 *
 * TODO(arch §2.5): once deliverables are surfaced through a repo read path,
 * publish only `{ conversationId, taskId }` and have subscribers re-read.
 */
import type { Redis as RedisClient } from 'ioredis';
import type { ConversationId } from '../contracts';
import type {
  ArtifactPublishedEvent,
  IArtifactNotifier,
} from './artifact-notifier';
import { loggerFor } from '../../services/logger';

const log = loggerFor('orchestrator.notifier.artifact.redis');

const channelFor = (conversationId: ConversationId): string =>
  `mypes:artifact:${conversationId}`;

export class RedisArtifactNotifier implements IArtifactNotifier {
  private readonly handlers = new Map<
    ConversationId,
    Set<(event: ArtifactPublishedEvent) => void>
  >();

  private readonly onMessage: (channel: string, message: string) => void;
  private listenerAttached = false;

  constructor(
    private readonly publisher: RedisClient,
    private readonly subscriber: RedisClient,
  ) {
    this.onMessage = (channel, message) => {
      const conversationId = parseConversationId(channel, 'mypes:artifact:');
      if (!conversationId) return;
      const set = this.handlers.get(conversationId);
      if (!set || set.size === 0) return;
      let parsed: ArtifactPublishedEvent;
      try {
        parsed = JSON.parse(message) as ArtifactPublishedEvent;
      } catch (err) {
        log.error({ err, channel }, 'notifier.artifact.parse_failed');
        return;
      }
      for (const handler of set) {
        try {
          handler(parsed);
        } catch (err) {
          log.error({ err, channel }, 'notifier.artifact.handler_threw');
        }
      }
    };
  }

  publish(event: ArtifactPublishedEvent): void {
    const channel = channelFor(event.conversationId);
    const payload = JSON.stringify(event);
    log.info(
      {
        channel,
        agentId: event.agentId,
        taskId: event.taskId,
        artifactCount: event.artifacts.length,
        payloadBytes: payload.length,
      },
      'notifier.artifact.publish.start',
    );
    this.publisher
      .publish(channel, payload)
      .then((subscribers) => {
        log.info(
          { channel, taskId: event.taskId, subscribers },
          subscribers === 0
            ? 'notifier.artifact.publish.no_subscribers'
            : 'notifier.artifact.publish.delivered',
        );
      })
      .catch((err) =>
        log.error({ err, channel }, 'notifier.artifact.publish_failed'),
      );
  }

  subscribe(
    conversationId: ConversationId,
    handler: (event: ArtifactPublishedEvent) => void,
  ): { dispose(): void } {
    if (!this.listenerAttached) {
      this.subscriber.on('message', this.onMessage);
      this.listenerAttached = true;
    }

    let set = this.handlers.get(conversationId);
    if (!set) {
      set = new Set();
      this.handlers.set(conversationId, set);
      this.subscriber
        .subscribe(channelFor(conversationId))
        .catch((err) =>
          log.error(
            { err, conversationId },
            'notifier.artifact.subscribe_failed',
          ),
        );
    }
    set.add(handler);

    return {
      dispose: () => {
        const current = this.handlers.get(conversationId);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          this.handlers.delete(conversationId);
          this.subscriber
            .unsubscribe(channelFor(conversationId))
            .catch((err) =>
              log.error(
                { err, conversationId },
                'notifier.artifact.unsubscribe_failed',
              ),
            );
        }
      },
    };
  }
}

function parseConversationId(channel: string, prefix: string): ConversationId | null {
  if (!channel.startsWith(prefix)) return null;
  const id = channel.slice(prefix.length);
  return id.length > 0 ? (id as ConversationId) : null;
}
