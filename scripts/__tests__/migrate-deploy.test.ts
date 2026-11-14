import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_TIMEOUT_MS,
  DeployConfigError,
  LOCK_BUSY_MESSAGE,
  MIGRATIONS_DIR,
  makeRedactor,
  resolveMigrationConfig,
  runDeployMigrations,
} from '../migrate-deploy-lib.mjs';

// Synthetic credentials only; no database is contacted (the runner is always a fake).
const ADMIN_URL = 'postgresql://postgres:s3cr3t-Pa55@db.internal.example:5432/creamype';
const APP_URL = 'postgresql://app_user:app-Pa55word@db.internal.example:5432/creamype';

type Applied = Array<{ name: string }>;

function harness(env: Record<string, string | undefined>, runner = vi.fn(async (): Promise<Applied> => [])) {
  const lines: string[] = [];
  const out = { info: (l: string) => lines.push(`INFO ${l}`), error: (l: string) => lines.push(`ERROR ${l}`) };
  let clock = 0;
  const sleep = vi.fn(async () => {});
  const run = () =>
    runDeployMigrations({ env, runner, out, now: () => (clock += 10), sleep, lockRetries: 2, lockRetryDelayMs: 1 });
  return { lines, runner, sleep, run };
}

function expectNoSecrets(lines: string[]) {
  const text = lines.join('\n');
  for (const secret of ['s3cr3t-Pa55', 'app-Pa55word', 'db.internal.example', 'postgresql://', 'postgres://']) {
    expect(text).not.toContain(secret);
  }
}

describe('resolveMigrationConfig guards', () => {
  it('accepts an admin URL and reports only the database name', () => {
    expect(resolveMigrationConfig({ MIGRATION_DATABASE_URL: ADMIN_URL, APP_DATABASE_URL: APP_URL })).toEqual({
      connectionString: ADMIN_URL,
      database: 'creamype',
    });
  });

  it.each([
    ['missing', {}],
    ['blank', { MIGRATION_DATABASE_URL: '   ' }],
    ['only DATABASE_URL set (never used as a fallback)', { DATABASE_URL: ADMIN_URL }],
    ['only APP_DATABASE_URL set', { APP_DATABASE_URL: APP_URL }],
  ])('fails closed when MIGRATION_DATABASE_URL is %s', (_label, env) => {
    expect(() => resolveMigrationConfig(env)).toThrow(/MIGRATION_DATABASE_URL is not set/);
  });

  it.each([
    ['not a URL', 'host=db user=postgres password=s3cr3t-Pa55'],
    ['another scheme', 'mysql://postgres:s3cr3t-Pa55@db.internal.example/creamype'],
    ['no database', 'postgresql://postgres:s3cr3t-Pa55@db.internal.example:5432/'],
    ['no user', 'postgresql://db.internal.example:5432/creamype'],
  ])('fails closed when the URL has %s', (_label, url) => {
    expect(() => resolveMigrationConfig({ MIGRATION_DATABASE_URL: url })).toThrow(DeployConfigError);
  });

  it.each(['app_user', 'APP_USER'])('rejects the runtime role (%s)', (user) => {
    const url = `postgresql://${user}:s3cr3t-Pa55@db.internal.example:5432/creamype`;
    expect(() => resolveMigrationConfig({ MIGRATION_DATABASE_URL: url })).toThrow(/runtime role app_user/);
  });

  it('rejects a URL equal to APP_DATABASE_URL, even with a non-app_user name', () => {
    const shared = 'postgresql://svc:s3cr3t-Pa55@db.internal.example:5432/creamype';
    expect(() => resolveMigrationConfig({ MIGRATION_DATABASE_URL: shared, APP_DATABASE_URL: shared })).toThrow(
      /is the runtime connection/,
    );
  });

  it('rejects the same user, host, port and database written differently', () => {
    const app = 'postgresql://svc:other@DB.internal.example/creamype?sslmode=require';
    const migration = 'postgres://svc:s3cr3t-Pa55@db.internal.example:5432/creamype';
    expect(() => resolveMigrationConfig({ MIGRATION_DATABASE_URL: migration, APP_DATABASE_URL: app })).toThrow(
      /is the runtime connection/,
    );
  });

  it('never puts any part of the URLs in its error messages', () => {
    const cases: Array<Record<string, string>> = [
      { MIGRATION_DATABASE_URL: 'mysql://postgres:s3cr3t-Pa55@db.internal.example/x' },
      { MIGRATION_DATABASE_URL: APP_URL },
      { MIGRATION_DATABASE_URL: ADMIN_URL, APP_DATABASE_URL: ADMIN_URL },
      { MIGRATION_DATABASE_URL: 'postgresql://db.internal.example/creamype' },
    ];
    for (const env of cases) {
      let message = '';
      try {
        resolveMigrationConfig(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expectNoSecrets([message]);
    }
  });
});

describe('makeRedactor', () => {
  it('removes the URL, any postgres URL, the password (raw and decoded) and the host', () => {
    const encoded = 'postgresql://postgres:p%40ss%2Fword@db.internal.example:5432/creamype';
    const redact = makeRedactor(encoded);
    const text = redact(
      `connect ${encoded} failed; retry postgres://x:y@other.example/z; password p@ss/word or p%40ss%2Fword at db.internal.example:5432`,
    );
    expect(text).not.toContain('p@ss/word');
    expect(text).not.toContain('p%40ss%2Fword');
    expect(text).not.toContain('db.internal.example');
    expect(text).not.toContain('other.example');
    expect(text).toContain('[redacted-url]');
  });
});

describe('runDeployMigrations', () => {
  it('returns 1 without calling the runner when the guard fails', async () => {
    const h = harness({ MIGRATION_DATABASE_URL: APP_URL, DATABASE_URL: ADMIN_URL });
    expect(await h.run()).toBe(1);
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/^ERROR \[migrate:deploy\] .*runtime role/);
    expectNoSecrets(h.lines);
  });

  it('runs node-pg-migrate up with the same table, schema, lock and transaction as the CLI scripts', async () => {
    const h = harness({ MIGRATION_DATABASE_URL: ADMIN_URL, APP_DATABASE_URL: APP_URL });
    expect(await h.run()).toBe(0);
    expect(h.runner).toHaveBeenCalledTimes(1);
    const options = (h.runner.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(options).toMatchObject({
      databaseUrl: { connectionString: ADMIN_URL, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS },
      dir: MIGRATIONS_DIR,
      migrationsTable: 'pgmigrations',
      schema: ['public'],
      direction: 'up',
      checkOrder: true,
      singleTransaction: true,
      noLock: false,
    });
    expect(options).not.toHaveProperty('migrationsSchema');
    expect(options).not.toHaveProperty('count');
    expect(String(MIGRATIONS_DIR)).toMatch(/[/\\]migrations$/);
  });

  it('exits 0 and says so when nothing is pending', async () => {
    const h = harness({ MIGRATION_DATABASE_URL: ADMIN_URL });
    expect(await h.run()).toBe(0);
    expect(h.lines.join('\n')).toMatch(/target database "creamype"/);
    expect(h.lines.at(-1)).toMatch(/no pending migrations \(\d+ms\)/);
    expectNoSecrets(h.lines);
  });

  it('lists applied migration names', async () => {
    const runner = vi.fn(async (): Promise<Applied> => [{ name: '1792900000000_a' }, { name: '1792900001000_b' }]);
    const h = harness({ MIGRATION_DATABASE_URL: ADMIN_URL }, runner);
    expect(await h.run()).toBe(0);
    expect(h.lines.at(-1)).toMatch(/applied 2 migration\(s\): 1792900000000_a, 1792900001000_b/);
  });

  it('exits 1 on a migration error and redacts secrets from the error and from runner logs', async () => {
    const runner = vi.fn(async (options: { logger: { error: (m: string) => void } }): Promise<Applied> => {
      options.logger.error(`could not connect to postgres: ${ADMIN_URL}`);
      throw new Error(`password authentication failed (s3cr3t-Pa55) for ${ADMIN_URL} at db.internal.example`);
    });
    const h = harness({ MIGRATION_DATABASE_URL: ADMIN_URL }, runner as never);
    expect(await h.run()).toBe(1);
    expect(h.lines.at(-1)).toMatch(/^ERROR \[migrate:deploy\] failed after \d+ms: password authentication failed/);
    expectNoSecrets(h.lines);
  });

  it('reports a connection failure in one line with its code, without the driver dump', async () => {
    const runner = vi.fn(async (options: { logger: { error: (m: string) => void } }): Promise<Applied> => {
      options.logger.error("could not connect to postgres: AggregateError [ECONNREFUSED] address: '10.0.0.7', port: 5432");
      throw Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    });
    const h = harness({ MIGRATION_DATABASE_URL: ADMIN_URL }, runner as never);
    expect(await h.run()).toBe(1);
    expect(h.lines.join('\n')).not.toContain('10.0.0.7');
    expect(h.lines.at(-1)).toMatch(/failed after \d+ms: AggregateError \(code ECONNREFUSED\)$/);
  });

  it('adds the SQLSTATE to a migration error', async () => {
    const runner = vi.fn(async (): Promise<Applied> => {
      throw Object.assign(new Error('relation "tenants" already exists'), { code: '42P07' });
    });
    const h = harness({ MIGRATION_DATABASE_URL: ADMIN_URL }, runner);
    expect(await h.run()).toBe(1);
    expect(h.lines.at(-1)).toMatch(/relation "tenants" already exists \(code 42P07\)$/);
  });

  it('waits and retries while another deploy holds the advisory lock', async () => {
    const runner = vi
      .fn<() => Promise<Applied>>()
      .mockRejectedValueOnce(new Error(LOCK_BUSY_MESSAGE))
      .mockResolvedValueOnce([]);
    const h = harness({ MIGRATION_DATABASE_URL: ADMIN_URL }, runner);
    expect(await h.run()).toBe(0);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });

  it('fails once the lock retries are exhausted', async () => {
    const runner = vi.fn<() => Promise<Applied>>().mockRejectedValue(new Error(LOCK_BUSY_MESSAGE));
    const h = harness({ MIGRATION_DATABASE_URL: ADMIN_URL }, runner);
    expect(await h.run()).toBe(1);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(h.lines.at(-1)).toMatch(/Another migration is already running/);
  });
});
