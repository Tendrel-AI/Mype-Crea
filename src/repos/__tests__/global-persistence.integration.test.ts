/**
 * Real app_user/RLS coverage for KAN-71 global persistence. Uses only random synthetic
 * fixtures and is intentionally gated on distinct owner/app database URLs. Do not run
 * without explicit approval because this connects to the configured database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { withGlobalTransaction } from '../../db/global-transaction';
import { withTenantTransaction } from '../../db/with-transaction';
import { globalRepos } from '../global';

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;

SUITE('KAN-71 global persistence (integration)', () => {
  let owner: pg.Client;
  const workosUserId = `user_${randomUUID().replaceAll('-', '')}`;
  const operationKey = `kan71-${randomUUID()}`;
  let tenantId: string | undefined;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl || ownerUrl === appUrl) {
      throw new Error('Use distinct DATABASE_URL fixture-owner and APP_DATABASE_URL app_user connections.');
    }
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const ownerRole = await owner.query<{ current_user: string }>('SELECT current_user');
    if (ownerRole.rows[0]?.current_user === 'app_user') throw new Error('DATABASE_URL must not use app_user.');
    const appRole = await getPool().query<{ current_user: string }>('SELECT current_user');
    if (appRole.rows[0]?.current_user !== 'app_user') throw new Error('APP_DATABASE_URL must connect as app_user.');
    await owner.query(
      `INSERT INTO platform_superadmins(workos_user_id, granted_by_workos_user_id, grant_source)
       VALUES ($1, $1, 'authorized')`, [workosUserId],
    );
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('BEGIN');
      try {
        await owner.query('SET LOCAL session_replication_role = replica');
        await owner.query(`DELETE FROM platform_audit_events WHERE actor_workos_user_id = $1`, [workosUserId]);
        await owner.query(`DELETE FROM platform_org_operations WHERE operation_key = $1`, [operationKey]);
        await owner.query(`DELETE FROM platform_superadmins WHERE workos_user_id = $1`, [workosUserId]);
        if (tenantId) await owner.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
      }
      await owner.end();
    }
    await closePool();
  });

  it('forces RLS, denies bare app_user global reads, and keeps tenant content inaccessible in global context', async () => {
    const role = await owner.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname='app_user'`,
    );
    expect(role.rows[0]?.rolbypassrls).toBe(false);
    const protectedTables = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relkind='r' AND relname = ANY($1::text[])`,
      [[
        'platform_superadmins', 'platform_bootstrap_state', 'platform_audit_events',
        'platform_org_operations', 'platform_module_versions', 'platform_module_defaults',
        'platform_module_assignments', 'platform_module_operations',
      ]],
    );
    expect(protectedTables.rows).toHaveLength(8);
    expect(protectedTables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const hiddenRole = await withTenantTransaction({ id: randomUUID() }, undefined, async (tx) =>
      tx.query<{ count: string }>('SELECT count(*)::text AS count FROM platform_superadmins'),
    );
    expect(hiddenRole.rows[0]?.count).toBe('0');
    const hiddenUsers = await withGlobalTransaction(async (tx) =>
      tx.query<{ count: string }>('SELECT count(*)::text AS count FROM users'),
    );
    expect(hiddenUsers.rows[0]?.count).toBe('0');
  });

  it('stages one inactive organization idempotently and rejects a changed replay payload', async () => {
    const organizations = globalRepos().organizations;
    const first = await organizations.createPending({
      operationKey, name: 'KAN-71 synthetic organization', actorWorkosUserId: workosUserId,
      reason: 'Integration fixture',
    });
    tenantId = first.tenantId;
    expect(first.created).toBe(true);

    const replay = await organizations.createPending({
      operationKey, name: 'KAN-71 synthetic organization', actorWorkosUserId: workosUserId,
      reason: 'Integration fixture retry',
    });
    expect(replay).toEqual({ tenantId, created: false });
    await expect(organizations.createPending({
      operationKey, name: 'Different payload', actorWorkosUserId: workosUserId,
      reason: 'Invalid replay',
    })).rejects.toThrow('already used with different input');

    const stored = await organizations.getById(tenantId);
    expect(stored).toMatchObject({ name: 'KAN-71 synthetic organization', status: 'inactive' });
  });

  it('exposes only fixed-month aggregate columns through the platform metrics function', async () => {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    const month = monthStart.toISOString().slice(0, 10);
    const result = await withGlobalTransaction((tx) =>
      tx.query(`SELECT * FROM app.platform_monthly_metrics($1::date)`, [month]),
    );
    expect(result.fields.map((field) => field.name)).toEqual([
      'period_start', 'organization_id', 'organization_name', 'active_users',
      'new_conversations', 'provider_model_usage', 'estimated_cost', 'errors', 'active_versions',
    ]);
    expect(result.rows.some((row) => row.organization_id === null)).toBe(true);
    await expect(withGlobalTransaction((tx) =>
      tx.query(`SELECT * FROM app.platform_monthly_metrics($1::date)`, ['2020-01-02']),
    )).rejects.toThrow('first day of a calendar month');
  });
});
