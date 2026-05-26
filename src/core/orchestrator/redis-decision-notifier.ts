/**
 * Redis Pub/Sub-backed IDecisionNotifier.
 *
 * Channel: `mypes:decision:<conversationId>`.
 *
 * Per architecture §2.5 the wake-up notification "carries only the task or
 * decision ID" and subscribers re-read the authoritative row from Postgres.
 * For Phase 1 this notifier publishes the full PlannerDecision payload as a
 * transitional shape so existing in-process consumers behave identically
 * after the transport flip; tightening to ID-only requires a persisted-
 * decisions read path that does not exist yet.
 *
 * TODO(arch §2.5): once decisions are persisted (an `agent_decisions` table
 * or equivalent), publish only `{ conversationId, decisionId }` here and
 * have subscribers re-read.
 *
 * Failure handling: publish errors are logged but never thrown. Lost
 * notifications are acceptable per architecture; the sweeper recovers.
 */
import type { Redis as RedisClient } from 'ioredis';
import type { ConversationId, PlannerDecision } from '../contracts';
import type { IDecisionNotifier } from './orchestrator-core';
import { loggerFor } from '../../services/logger';

const log = loggerFor('orchestrator.notifier.decision.redis');

const channelFor = (conversationId: ConversationId): string =>
  `mypes:decision:${conversationId}`;

export class RedisDecisionNotifier implements IDecisionNotifier {
  /** conversationId -> active local handlers for that channel. */
  private readonly handlers = new Map<
    ConversationId,
    Set<(decision: PlannerDecision) => void>
  >();

  /** Bound listener attached to the subscriber's `'message'` event. */
  private readonly onMessage: (channel: string, message: string) => void;

  /** Tracks whether onMessage has been attached to the subscriber yet. */
  private listenerAttached = false;

  constructor(
    private readonly publisher: RedisClient,
    private readonly subscriber: RedisClient,
  ) {
    this.onMessage = (channel, message) => {
      const conversationId = parseConversationId(channel, 'mypes:decision:');
      if (!conversationId) return;
      const set = this.handlers.get(conversationId);
      if (!set || set.size === 0) return;
      let parsed: PlannerDecision;
      try {
        parsed = JSON.parse(message) as PlannerDecision;
      } catch (err) {
        log.error({ err, channel }, 'notifier.decision.parse_failed');
        return;
      }
      for (const handler of set) {
        try {
          handler(parsed);
        } catch (err) {
          log.error({ err, channel }, 'notifier.decision.handler_threw');
        }
      }
    };
  }

  notify(conversationId: ConversationId, decision: PlannerDecision): void {
    const channel = channelFor(conversationId);
    this.publisher
      .publish(channel, JSON.stringify(decision))
      .catch((err) => log.error({ err, channel }, 'notifier.decision.publish_failed'));
  }

  subscribe(
    conversationId: ConversationId,
    handler: (decision: PlannerDecision) => void,
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
            'notifier.decision.subscribe_failed',
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
                'notifier.decision.unsubscribe_failed',
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
