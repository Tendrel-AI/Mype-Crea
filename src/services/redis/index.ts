/**
 * Redis client singletons for the orchestrator's wake-up channel.
 *
 * Two clients per process: a publisher (issues commands) and a subscriber
 * (receives messages). ioredis forbids issuing arbitrary commands on a
 * connection that is in subscriber mode, so they cannot share a connection.
 *
 * Both are lazy: constructed on first call to the corresponding getter so
 * importing this module during build/SSR does not connect, and so unit tests
 * that swap providers don't need a live Redis. When `REDIS_URL` is unset,
 * the getters return `null` and callers fall back to in-process notifiers
 * (see src/core/orchestrator/notifiers.ts).
 *
 * Mirrors the singleton shape of src/services/llm/index.ts.
 *
 * See docs/agents/architecture.md §2.5, §2.10.
 */
import Redis, { type Redis as RedisClient } from 'ioredis';
import { loggerFor } from '../logger';

const log = loggerFor('services.redis');

// Cached on globalThis so that multiple Next.js server bundles (server actions,
// route handlers, RSC) that each evaluate this module share the same ioredis
// connection pair instead of opening duplicates. The wrapper object lets us
// distinguish "not built" (slot absent) from "built but disabled" (slot
// present, client === null).
const PUBLISHER_SLOT = Symbol.for('mypes.redis.publisher');
const SUBSCRIBER_SLOT = Symbol.for('mypes.redis.subscriber');
type Slot = { client: RedisClient | null };
type RedisHolder = {
  [PUBLISHER_SLOT]?: Slot;
  [SUBSCRIBER_SLOT]?: Slot;
};
const holder = globalThis as unknown as RedisHolder;

function build(role: 'publisher' | 'subscriber'): RedisClient | null {
  const url = process.env.REDIS_URL;
  if (!url || url.trim().length === 0) {
    log.warn(
      { role },
      'redis.disabled.no_redis_url',
    );
    return null;
  }
  const client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    // Keep ioredis quiet about reconnects in dev; the lifecycle events below
    // log structured entries instead.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  client.on('connect', () => log.info({ role }, 'redis.connect'));
  client.on('ready', () => log.info({ role }, 'redis.ready'));
  client.on('error', (err) => log.error({ role, err }, 'redis.error'));
  client.on('close', () => log.info({ role }, 'redis.close'));
  client.on('reconnecting', (delay: number) =>
    log.warn({ role, delayMs: delay }, 'redis.reconnecting'),
  );
  return client;
}

export function getRedisPublisher(): RedisClient | null {
  const existing = holder[PUBLISHER_SLOT];
  if (existing) return existing.client;
  const client = build('publisher');
  holder[PUBLISHER_SLOT] = { client };
  return client;
}

export function getRedisSubscriber(): RedisClient | null {
  const existing = holder[SUBSCRIBER_SLOT];
  if (existing) return existing.client;
  const client = build('subscriber');
  holder[SUBSCRIBER_SLOT] = { client };
  return client;
}

/** Test hook: swap clients (e.g. for ioredis-mock) or clear for re-construction. */
export function setRedisClients(
  next: { publisher?: RedisClient | null; subscriber?: RedisClient | null },
): void {
  if ('publisher' in next) {
    holder[PUBLISHER_SLOT] = { client: next.publisher ?? null };
  }
  if ('subscriber' in next) {
    holder[SUBSCRIBER_SLOT] = { client: next.subscriber ?? null };
  }
}

/** Test hook: drop cached singletons so the next getter rebuilds. */
export function resetRedis(): void {
  delete holder[PUBLISHER_SLOT];
  delete holder[SUBSCRIBER_SLOT];
}

export type RedisProbeResult = 'ok' | 'not_configured';

/**
 * Readiness check for the shared publisher connection (`GET /api/health/ready`).
 *
 * Returns `'not_configured'` when `REDIS_URL` is unset, `'ok'` when the
 * publisher is connected and answers PING within `timeoutMs`, and rejects
 * otherwise. It waits for the `ready` state instead of issuing PING on a
 * disconnected client: the publisher uses `maxRetriesPerRequest: null`, so a
 * command sent while offline would sit in the offline queue indefinitely.
 */
export async function probeRedis(timeoutMs: number): Promise<RedisProbeResult> {
  const client = getRedisPublisher();
  if (!client) return 'not_configured';
  const deadline = Date.now() + timeoutMs;
  await waitUntilReady(client, timeoutMs);
  const reply = await withTimeout(client.ping(), Math.max(deadline - Date.now(), 1), 'PING');
  if (reply !== 'PONG') throw new Error('Unexpected Redis PING reply');
  return 'ok';
}

function waitUntilReady(client: RedisClient, timeoutMs: number): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  if (client.status === 'end') return Promise.reject(new Error('Redis connection has ended'));
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error(`Redis not ready within ${timeoutMs} ms`));
    }, timeoutMs);
    client.once('ready', onReady);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis ${label} exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
