/**
 * Transaction boundary for the unauthenticated readiness probe
 * (`GET /api/health/ready`).
 *
 * Unlike `withTenantTransaction` / `withGlobalTransaction`, this helper binds
 * NO identity GUCs (`app.tenant_id`, `app.user_id`, `app.is_platform_admin`):
 * a probe has no caller identity and must not run with elevated RLS context.
 * The transaction is READ ONLY and gets a local `statement_timeout`, and the
 * whole operation (pool checkout included) is bounded by `timeoutMs`, so a
 * hung database cannot hang the probe. It uses the same `app_user` pool as
 * every other repository helper.
 *
 * Only `src/repos/health.ts` should call this; do not reuse it for queries
 * that read tables.
 */
import type { PoolClient } from 'pg';
import { getPool } from './pool';

export type ProbeTxClient = Pick<PoolClient, 'query'>;

export class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Database probe exceeded ${timeoutMs} ms`);
    this.name = 'ProbeTimeoutError';
  }
}

export async function withProbeTransaction<T>(
  timeoutMs: number,
  fn: (tx: ProbeTxClient) => Promise<T>,
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<T> => {
    const client = await getPool().connect();
    let failure: unknown;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(timeoutMs)]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failure = error;
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      // A connection that failed or outlived the deadline is discarded instead
      // of being returned to the pool in an unknown state.
      client.release(failure !== undefined || timedOut ? true : undefined);
    }
  };

  const work = run();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new ProbeTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    // The losing promise may still settle later; never leave it unhandled.
    work.catch(() => undefined);
  }
}
