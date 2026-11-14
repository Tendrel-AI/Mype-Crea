/**
 * Generic notification channels over the notification contract (KAN-58).
 *
 * Every notifier (decision, artifact, lifecycle) is a thin wrapper over one
 * of these two classes, so the wire handling exists exactly once:
 *
 *   - `RedisNotificationChannel` publishes `serializeNotification(n)` on the
 *     contract's channel (`redisChannelFor`) and, per message, checks that the
 *     channel belongs to its kind, parses the payload with `parseNotification`
 *     and checks that the payload's scope matches the channel. Anything else
 *     is logged and dropped; a handler that throws is logged and isolated.
 *   - `InProcessNotificationChannel` (single-process dev/tests) round-trips
 *     every notification through the same serialize/parse, so a contract
 *     violation shows up locally exactly as it would over Redis.
 *
 * Publishing is best-effort: errors are logged, never thrown (architecture
 * §2.5: lost notifications are recovered by the durable paths).
 */
import { EventEmitter } from 'node:events';
import type { Redis as RedisClient } from 'ioredis';
import {
  notification,
  parseNotification,
  payloadOf,
  redisChannelFor,
  redisChannelName,
  redisChannelScope,
  serializeNotification,
  type NotificationOf,
  type NotificationPayload,
  type RedisNotificationKind,
} from '../contracts/notifications';
import { loggerFor } from '../../services/logger';

type Handler<K extends RedisNotificationKind> = (payload: NotificationPayload<K>) => void;

export interface NotificationChannel<K extends RedisNotificationKind> {
  publish(payload: NotificationPayload<K>): void;
  subscribe(scopeId: string, handler: Handler<K>): { dispose(): void };
}

function deliver<K extends RedisNotificationKind>(
  log: ReturnType<typeof loggerFor>,
  kind: K,
  channel: string,
  handlers: Iterable<Handler<K>>,
  n: NotificationOf<K>,
): void {
  const payload = payloadOf(n);
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (err) {
      log.error({ err, channel, kind }, 'notifier.handler_threw');
    }
  }
}

/** Parse one raw message for `kind` on `channel`; null (logged) when it must be dropped. */
function accept<K extends RedisNotificationKind>(
  log: ReturnType<typeof loggerFor>,
  kind: K,
  channel: string,
  scope: string,
  raw: string,
): NotificationOf<K> | null {
  const parsed = parseNotification(raw, [kind]);
  if (!parsed.ok) {
    log.error({ channel, kind, reason: parsed.reason, detail: parsed.detail }, 'notifier.notification_rejected');
    return null;
  }
  const n = parsed.notification as NotificationOf<K>;
  if (redisChannelFor(n) !== redisChannelName(kind, scope)) {
    log.error({ channel, kind, reason: 'scope_mismatch' }, 'notifier.notification_rejected');
    return null;
  }
  return n;
}

export class RedisNotificationChannel<K extends RedisNotificationKind> implements NotificationChannel<K> {
  private readonly log: ReturnType<typeof loggerFor>;
  private readonly handlers = new Map<string, Set<Handler<K>>>();
  private readonly onMessage: (channel: string, message: string) => void;
  private listenerAttached = false;

  constructor(
    private readonly kind: K,
    private readonly publisher: RedisClient,
    private readonly subscriber: RedisClient,
  ) {
    this.log = loggerFor(`orchestrator.notifier.${kind}.redis`);
    this.onMessage = (channel, message) => {
      const scope = redisChannelScope(this.kind, channel);
      if (!scope) return; // another kind's channel on the shared subscriber
      const set = this.handlers.get(scope);
      if (!set || set.size === 0) return;
      const n = accept(this.log, this.kind, channel, scope, message);
      if (n) deliver(this.log, this.kind, channel, set, n);
    };
  }

  publish(payload: NotificationPayload<K>): void {
    const n = notification(this.kind, payload);
    const channel = redisChannelFor(n);
    const body = serializeNotification(n);
    this.publisher
      .publish(channel, body)
      .then((subscribers) => {
        this.log.debug(
          { channel, subscribers, payloadBytes: body.length },
          subscribers === 0 ? 'notifier.publish.no_subscribers' : 'notifier.publish.delivered',
        );
      })
      .catch((err) => this.log.error({ err, channel }, 'notifier.publish_failed'));
  }

  subscribe(scopeId: string, handler: Handler<K>): { dispose(): void } {
    if (!this.listenerAttached) {
      this.subscriber.on('message', this.onMessage);
      this.listenerAttached = true;
    }
    const channel = redisChannelName(this.kind, scopeId);
    let set = this.handlers.get(scopeId);
    if (!set) {
      set = new Set();
      this.handlers.set(scopeId, set);
      this.subscriber
        .subscribe(channel)
        .catch((err) => this.log.error({ err, channel }, 'notifier.subscribe_failed'));
    }
    set.add(handler);

    return {
      dispose: () => {
        const current = this.handlers.get(scopeId);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          this.handlers.delete(scopeId);
          this.subscriber
            .unsubscribe(channel)
            .catch((err) => this.log.error({ err, channel }, 'notifier.unsubscribe_failed'));
        }
      },
    };
  }
}

export class InProcessNotificationChannel<K extends RedisNotificationKind> implements NotificationChannel<K> {
  private readonly log: ReturnType<typeof loggerFor>;
  private readonly emitter = new EventEmitter();

  constructor(private readonly kind: K) {
    this.log = loggerFor(`orchestrator.notifier.${kind}.in_process`);
  }

  publish(payload: NotificationPayload<K>): void {
    const n = notification(this.kind, payload);
    const channel = redisChannelFor(n);
    const listeners = this.emitter.listenerCount(channel);
    this.log.debug(
      { channel, subscribers: listeners },
      listeners === 0 ? 'notifier.publish.no_subscribers' : 'notifier.publish.delivered',
    );
    if (listeners === 0) return;
    this.emitter.emit(channel, serializeNotification(n));
  }

  subscribe(scopeId: string, handler: Handler<K>): { dispose(): void } {
    const channel = redisChannelName(this.kind, scopeId);
    const listener = (raw: string): void => {
      const n = accept(this.log, this.kind, channel, scopeId, raw);
      if (n) deliver(this.log, this.kind, channel, [handler], n);
    };
    this.emitter.on(channel, listener);
    return { dispose: () => this.emitter.off(channel, listener) };
  }
}
