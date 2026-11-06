import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../../db/pool', () => ({
  getPool: () => ({ connect: db.connect }),
}));

import { healthRepo } from '../health';
import { ProbeTimeoutError } from '../../db/probe-transaction';

const client = () => ({ query: db.query, release: db.release });

describe('healthRepo().pingDatabase', () => {
  beforeEach(() => {
    db.connect.mockImplementation(async () => client());
    db.query.mockImplementation(async (sql: string) =>
      sql === 'SELECT 1 AS ok' ? { rows: [{ ok: 1 }] } : { rows: [] },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('runs SELECT 1 in a read-only transaction with a statement timeout and no identity GUCs', async () => {
    await healthRepo().pingDatabase(1_500);

    const statements = db.query.mock.calls.map((call) => call[0] as string);
    expect(statements).toEqual([
      'BEGIN READ ONLY',
      `SELECT set_config('statement_timeout', $1, true)`,
      'SELECT 1 AS ok',
      'COMMIT',
    ]);
    expect(db.query.mock.calls[1][1]).toEqual(['1500']);
    expect(statements.join('\n')).not.toMatch(/app\.(tenant_id|user_id|is_platform_admin|is_tenant_admin)/);
    // Healthy connection goes back to the pool.
    expect(db.release).toHaveBeenCalledWith(undefined);
  });

  it('rolls back, discards the connection, and rejects when the query fails', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT 1 AS ok') throw new Error('boom');
      return { rows: [] };
    });

    await expect(healthRepo().pingDatabase(1_000)).rejects.toThrow('boom');
    expect(db.query.mock.calls.map((call) => call[0])).toContain('ROLLBACK');
    expect(db.release).toHaveBeenCalledWith(true);
  });

  it('rejects when the pool cannot connect', async () => {
    db.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(healthRepo().pingDatabase(1_000)).rejects.toThrow('ECONNREFUSED');
  });

  it('times out a hung connection attempt and discards the late connection', async () => {
    vi.useFakeTimers();
    let resolveConnect: (value: ReturnType<typeof client>) => void = () => undefined;
    db.connect.mockReturnValue(new Promise((resolve) => { resolveConnect = resolve; }));

    const ping = healthRepo().pingDatabase(500);
    const assertion = expect(ping).rejects.toBeInstanceOf(ProbeTimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    resolveConnect(client());
    await vi.runAllTimersAsync();
    expect(db.release).toHaveBeenCalledWith(true);
  });

  it('times out a hung query', async () => {
    vi.useFakeTimers();
    db.query.mockImplementation((sql: string) =>
      sql === 'SELECT 1 AS ok' ? new Promise(() => undefined) : Promise.resolve({ rows: [] }),
    );

    const ping = healthRepo().pingDatabase(500);
    const assertion = expect(ping).rejects.toBeInstanceOf(ProbeTimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });
});
