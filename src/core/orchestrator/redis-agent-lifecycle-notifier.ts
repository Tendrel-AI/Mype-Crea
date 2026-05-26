/**
 * Redis Pub/Sub-backed IAgentLifecycleNotifier.
 *
 * Channel: `mypes:lifecycle:processing:<conversationId>`.
 *
 * Mirrors the structure of RedisArtifactNotifier — see that file for the
 * architectural notes (§2.5 wake-up channel, transitional payload shape,
 * best-effort failure handling). One channel per (event-kind, conversation)
 * keeps every subscriber narrow and avoids cross-conversation fan-out.
 */
import type { Redis as RedisClient } from 'ioredis';
import type { ConversationId } from '../contracts';
import type {
  AgentTaskProcessingEvent,
  IAgentLifecycleNotifier,
} from './agent-lifecycle-notifier';
import { loggerFor } from '../../services/logger';

const log = loggerFor('orchestrator.notifier.lifecycle.redis');

const PROCESSING_PREFIX = 'mypes:lifecycle:processing:';

const channelForProcessing = (conversationId: ConversationId): string =>
  `${PROCESSING_PREFIX}${conversationId}`;

export class RedisAgentLifecycleNotifier implements IAgentLifecycleNotifier {
  private readonly handlers = new Map<
    ConversationId,
    Set<(event: AgentTaskProcessingEvent) => void>
  >();

  private readonly onMessage: (channel: string, message: string) => void;
  private listenerAttached = false;

  constructor(
    private readonly publisher: RedisClient,
    private readonly subscriber: RedisClient,
  ) {
    this.onMessage = (channel, message) => {
      if (!channel.startsWith(PROCESSING_PREFIX)) return;
      const conversationId = channel.slice(PROCESSING_PREFIX.length) as ConversationId;
      const set = this.handlers.get(conversationId);
      if (!set || set.size === 0) return;
      let parsed: AgentTaskProcessingEvent;
      try {
        parsed = JSON.parse(message) as AgentTaskProcessingEvent;
      } catch (err) {
        log.error({ err, channel }, 'notifier.lifecycle.parse_failed');
        return;
      }
      for (const handler of set) {
        try {
          handler(parsed);
        } catch (err) {
          log.error({ err, channel }, 'notifier.lifecycle.handler_threw');
        }
      }
    };
  }

  publishProcessing(event: AgentTaskProcessingEvent): void {
    const channel = channelForProcessing(event.conversationId);
    this.publisher
      .publish(channel, JSON.stringify(event))
      .catch((err) =>
        log.error({ err, channel }, 'notifier.lifecycle.publish_failed'),
      );
  }

  subscribeProcessing(
    conversationId: ConversationId,
    handler: (event: AgentTaskProcessingEvent) => void,
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
        .subscribe(channelForProcessing(conversationId))
        .catch((err) =>
          log.error(
            { err, conversationId },
            'notifier.lifecycle.subscribe_failed',
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
            .unsubscribe(channelForProcessing(conversationId))
            .catch((err) =>
              log.error(
                { err, conversationId },
                'notifier.lifecycle.unsubscribe_failed',
              ),
            );
        }
      },
    };
  }
}
