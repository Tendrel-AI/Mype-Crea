import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pingDatabase: vi.fn<(timeoutMs: number) => Promise<void>>(),
  probeRedis: vi.fn<(timeoutMs: number) => Promise<'ok' | 'not_configured'>>(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../../../src/repos/health', () => ({
  healthRepo: () => ({ pingDatabase: mocks.pingDatabase }),
}));
vi.mock('../../../../src/services/redis', () => ({
  probeRedis: mocks.probeRedis,
}));
vi.mock('../../../../src/services/logger', () => ({
  loggerFor: () => ({ error: mocks.logError, warn: mocks.logWarn, info: vi.fn(), debug: vi.fn() }),
}));

import * as liveness from '../route';
import * as readiness from '../ready/route';

// Details a real driver error could carry. None of them may reach the body.
const SENSITIVE_DB_ERROR = new Error(
  'connect ECONNREFUSED 10.0.0.12:5432 postgres://app_user:s3cret@db.internal.railway:5432/mype',
);
const SENSITIVE_REDIS_ERROR = new Error('getaddrinfo ENOTFOUND redis.railway.internal redis://default:hunter2@redis:6379');

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/health (liveness)', () => {
  it('returns 200 with a minimal body and touches no dependency', async () => {
    const response = liveness.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(mocks.pingDatabase).not.toHaveBeenCalled();
    expect(mocks.probeRedis).not.toHaveBeenCalled();
  });

  it('is never statically cached', () => {
    expect(liveness.dynamic).toBe('force-dynamic');
  });
});

describe('GET /api/health/ready (readiness)', () => {
  it('returns 200 when the database and Redis are ok', async () => {
    mocks.pingDatabase.mockResolvedValue(undefined);
    mocks.probeRedis.mockResolvedValue('ok');

    const response = await readiness.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok' } });
    expect(mocks.pingDatabase).toHaveBeenCalledWith(expect.any(Number));
    expect(mocks.probeRedis).toHaveBeenCalledWith(expect.any(Number));
  });

  it('returns 503 when the database check fails', async () => {
    mocks.pingDatabase.mockRejectedValue(SENSITIVE_DB_ERROR);
    mocks.probeRedis.mockResolvedValue('ok');

    const response = await readiness.GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'fail', checks: { database: 'fail', redis: 'ok' } });
  });

  it('returns 503 when Redis is configured and fails', async () => {
    mocks.pingDatabase.mockResolvedValue(undefined);
    mocks.probeRedis.mockRejectedValue(SENSITIVE_REDIS_ERROR);

    const response = await readiness.GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'fail', checks: { database: 'ok', redis: 'fail' } });
  });

  it('returns 200 and skips Redis when REDIS_URL is not configured', async () => {
    mocks.pingDatabase.mockResolvedValue(undefined);
    mocks.probeRedis.mockResolvedValue('not_configured');

    const response = await readiness.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'skipped' } });
  });

  it('still returns 503 when the database fails and Redis is not configured', async () => {
    mocks.pingDatabase.mockRejectedValue(SENSITIVE_DB_ERROR);
    mocks.probeRedis.mockResolvedValue('not_configured');

    const response = await readiness.GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'fail', checks: { database: 'fail', redis: 'skipped' } });
  });

  it('never puts error details in the body, but logs them server-side', async () => {
    mocks.pingDatabase.mockRejectedValue(SENSITIVE_DB_ERROR);
    mocks.probeRedis.mockRejectedValue(SENSITIVE_REDIS_ERROR);

    const response = await readiness.GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ status: 'fail', checks: { database: 'fail', redis: 'fail' } });
    for (const leak of [
      'ECONNREFUSED', 'ENOTFOUND', '10.0.0.12', '5432', '6379', 'postgres://', 'redis://',
      'app_user', 's3cret', 'hunter2', 'railway', 'internal', 'Error', 'stack', ' at ',
    ]) {
      expect(body).not.toContain(leak);
    }
    // The only values allowed anywhere in the body.
    const values = JSON.stringify(JSON.parse(body)).match(/"[^"]*"/g) ?? [];
    expect(new Set(values)).toEqual(new Set(['"status"', '"fail"', '"checks"', '"database"', '"redis"']));

    const logged = JSON.stringify(mocks.logError.mock.calls);
    expect(logged).toContain('ECONNREFUSED');
    expect(logged).toContain('ENOTFOUND');
  });

  it('is never statically cached and runs on the Node.js runtime', () => {
    expect(readiness.dynamic).toBe('force-dynamic');
    expect(readiness.runtime).toBe('nodejs');
  });
});
