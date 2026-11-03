import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// KAN-53: the restore rehearsal must refuse to start when the environment points at a real
// database, before it creates, dumps, or connects to anything.
const SCRIPT = path.resolve(__dirname, '..', 'restore-rehearsal.sh');

function run(env: Record<string, string>) {
  return spawnSync('bash', [SCRIPT], {
    env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv, // Next's types require NODE_ENV; the guard test must pass a minimal env
    encoding: 'utf8',
  });
}

describe('restore-rehearsal.sh host guard', () => {
  it.each([
    ['DATABASE_URL', 'postgres://postgres:secret@db.railway.internal:5432/railway'],
    ['APP_DATABASE_URL', 'postgres://app_user:x@shuttle.proxy.rlwy.net:41234/railway'],
    ['MIGRATION_DATABASE_URL', 'postgresql://admin@10.0.0.5/railway?sslmode=require'],
    ['PGHOST', 'example.com'],
    ['PGHOSTADDR', '10.1.2.3'],
  ])('refuses a non-local %s', (name, value) => {
    const result = run({ [name]: value });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('REFUSED');
    expect(result.stdout).not.toContain('restore rehearsal');
  });
});
