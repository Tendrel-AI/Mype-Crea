/** Transaction boundary for the narrowly scoped platform metadata repositories. */
import type { PoolClient } from 'pg';
import { getPool } from './pool';
import { loggerFor } from '../services/logger';

const log = loggerFor('db.global-transaction');

export type GlobalTxClient = Pick<PoolClient, 'query'>;

export async function withGlobalTransaction<T>(
  fn: (tx: GlobalTxClient) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    log.debug({ mode: 'global' }, 'tx.begin');
    const result = await fn(client);
    await client.query('COMMIT');
    log.debug({ mode: 'global', durationMs: Date.now() - startedAt }, 'tx.commit');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    log.error({ mode: 'global', err: error instanceof Error ? error.message : String(error) }, 'tx.rollback');
    throw error;
  } finally {
    client.release();
  }
}
