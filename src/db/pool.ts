/**
 * The single pg.Pool used by the repository layer. Connects as `app_user`
 * (no BYPASSRLS) via APP_DATABASE_URL.
 *
 * IMPORTANT — only the repository layer may import from this file.
 * Application code goes through `repos(tenant, user)` (see src/repos).
 *
 * PgBouncer transaction-pooling notes:
 *   - Every DB operation must run inside an explicit transaction so the
 *     `app.tenant_id` / `app.user_id` GUCs we set with set_config(..., true)
 *     reset between tasks. See claude/skills/database/SKILL.md.
 *   - Do not use protocol-level prepared statements (do not pass `name:` to
 *     query). Parameterized queries with $1/$2 are fine — those are
 *     parameter bindings, not prepared-statement caches.
 */
import { Pool } from 'pg';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'APP_DATABASE_URL is not set. Repository code requires the app_user connection string.',
    );
  }
  pool = new Pool({
    connectionString,
    max: 10,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}
