import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Deploy wiring (KAN-83): the pieces Railway runs must agree with each other.
const ROOT = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const railway = JSON.parse(readFileSync(path.join(ROOT, 'railway.json'), 'utf8'));

describe('production start', () => {
  it('binds the standalone server to all interfaces', () => {
    // Next standalone listens on $HOSTNAME; Railway sets it to the container id, so the
    // healthcheck cannot connect unless the start command overrides it.
    expect(pkg.scripts.start).toBe('HOSTNAME=0.0.0.0 node .next/standalone/server.js');
  });

  it('railway.json starts the same command as npm start (node directly, no npm wrapper)', () => {
    expect(railway.deploy.startCommand).toBe(pkg.scripts.start);
  });
});

describe('deploy-time migrations', () => {
  it('railway.json runs migrate:deploy before deploying and gates on readiness', () => {
    expect(railway.build.buildCommand).toBe('npm run build');
    expect(railway.deploy.preDeployCommand).toEqual(['npm run migrate:deploy']);
    expect(railway.deploy.healthcheckPath).toBe('/api/health/ready');
  });

  it('migrate:deploy runs the deploy script without loading .env files', () => {
    expect(pkg.scripts['migrate:deploy']).toBe('node scripts/migrate-deploy.mjs');
    expect(pkg.scripts['migrate:deploy']).not.toMatch(/dotenv|env-file/);
  });

  it('node-pg-migrate is a runtime dependency, so a pruned deploy image can still migrate', () => {
    expect(pkg.dependencies['node-pg-migrate']).toBeDefined();
    expect(pkg.dependencies.pg).toBeDefined();
    expect(pkg.devDependencies['node-pg-migrate']).toBeUndefined();
  });
});
