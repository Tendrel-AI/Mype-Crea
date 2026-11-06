import { EventEmitter } from 'node:events';
import type { Redis as RedisClient } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  loggerFor: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { probeRedis, resetRedis, setRedisClients } from '../redis';

class FakeRedis extends EventEmitter {
  status = 'ready';
  ping = vi.fn(async () => 'PONG');
}

function install(fake: FakeRedis | null) {
  setRedisClients({ publisher: fake as unknown as RedisClient | null });
}

describe('probeRedis', () => {
  const originalUrl = process.env.REDIS_URL;

  afterEach(() => {
    resetRedis();
    vi.useRealTimers();
    if (originalUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalUrl;
  });

  it('reports not_configured when REDIS_URL is unset, without connecting', async () => {
    delete process.env.REDIS_URL;
    resetRedis();
    await expect(probeRedis(500)).resolves.toBe('not_configured');
  });

  it('pings a ready publisher', async () => {
    const fake = new FakeRedis();
    install(fake);
    await expect(probeRedis(500)).resolves.toBe('ok');
    expect(fake.ping).toHaveBeenCalledTimes(1);
  });

  it('waits for a connecting publisher to become ready before pinging', async () => {
    const fake = new FakeRedis();
    fake.status = 'connecting';
    install(fake);
    const probe = probeRedis(500);
    expect(fake.ping).not.toHaveBeenCalled();
    fake.status = 'ready';
    fake.emit('ready');
    await expect(probe).resolves.toBe('ok');
  });

  it('fails without queueing a PING when the publisher never becomes ready', async () => {
    vi.useFakeTimers();
    const fake = new FakeRedis();
    fake.status = 'reconnecting';
    install(fake);
    const probe = probeRedis(500);
    const assertion = expect(probe).rejects.toThrow(/not ready/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(fake.ping).not.toHaveBeenCalled();
    expect(fake.listenerCount('ready')).toBe(0);
  });

  it('fails when the connection has ended', async () => {
    const fake = new FakeRedis();
    fake.status = 'end';
    install(fake);
    await expect(probeRedis(500)).rejects.toThrow(/ended/);
  });

  it('fails when PING hangs past the deadline', async () => {
    vi.useFakeTimers();
    const fake = new FakeRedis();
    fake.ping.mockReturnValue(new Promise(() => undefined));
    install(fake);
    const probe = probeRedis(500);
    const assertion = expect(probe).rejects.toThrow(/PING exceeded/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('fails when PING errors', async () => {
    const fake = new FakeRedis();
    fake.ping.mockRejectedValue(new Error('NOAUTH'));
    install(fake);
    await expect(probeRedis(500)).rejects.toThrow('NOAUTH');
  });
});
