/**
 * Transaction helpers. Every DB operation in the repository layer is expected
 * to be wrapped in `withTenantTransaction` (or `withTenantAdminTransaction`
 * for admin-bypass paths). These helpers ensure the GUCs are set BEFORE any
 * subsequent query runs, so RLS policies see the right tenant/user.
 */
import type { PoolClient } from 'pg';
import type { UUID } from '../core/contracts';
import { getPool } from './pool';
import { loggerFor } from '../services/logger';

const log = loggerFor('db.transaction');

export interface Tenant {
  readonly id: UUID;
}

export interface User {
  readonly id: UUID;
}

export type TxClient = Pick<PoolClient, 'query'>;

/**
 * Run `fn` inside a single transaction with `app.tenant_id` (and optionally
 * `app.user_id`) bound. Commits on success, rolls back on throw.
 *
 * Use this for any tenant-scoped read or write. If the operation also touches
 * a user-scoped table (conversations, messages, deliverables), pass `user`.
 */
export async function withTenantTransaction<T>(
  tenant: Tenant,
  user: User | undefined,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);
    if (user) {
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
    }
    log.trace( // fires ~1x/s per open tab (SSE poll); trace keeps debug readable
      { tenantId: tenant.id, userId: user?.id, mode: 'tenant' },
      'tx.begin',
    );
    const result = await fn(client);
    await client.query('COMMIT');
    log.trace(
      { tenantId: tenant.id, userId: user?.id, mode: 'tenant', durationMs: Date.now() - t0 },
      'tx.commit',
    );
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    log.error(
      { tenantId: tenant.id, userId: user?.id, mode: 'tenant', err: (err as Error).message },
      'tx.rollback',
    );
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Tenant-admin variant for tenant-wide operations that must bypass user-axis
 * RLS (e.g. listing all conversations in a tenant for a support tool).
 * Sets `app.is_tenant_admin = 'true'`. Use sparingly; prefer the user-scoped
 * helper above.
 */
export async function withTenantAdminTransaction<T>(
  tenant: Tenant,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);
    await client.query(`SELECT set_config('app.is_tenant_admin', 'true', true)`);
    log.info({ tenantId: tenant.id, mode: 'tenant_admin' }, 'tx.begin');
    const result = await fn(client);
    await client.query('COMMIT');
    log.info(
      { tenantId: tenant.id, mode: 'tenant_admin', durationMs: Date.now() - t0 },
      'tx.commit',
    );
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    log.error(
      { tenantId: tenant.id, mode: 'tenant_admin', err: (err as Error).message },
      'tx.rollback',
    );
    throw err;
  } finally {
    client.release();
  }
}
