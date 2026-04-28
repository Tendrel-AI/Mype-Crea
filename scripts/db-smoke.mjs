// Quick connectivity + RLS posture check against APP_DATABASE_URL.
// Run with:  node --env-file=.env.local scripts/db-smoke.mjs

import pg from 'pg';

const url = process.env.APP_DATABASE_URL;
if (!url) {
  console.error('APP_DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  const who = await client.query(`SELECT current_user, current_database()`);
  console.log('connected as', who.rows[0]);

  const rls = await client.query(`
    SELECT c.relname AS tablename, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  `);
  console.log('rls posture:');
  for (const r of rls.rows) {
    console.log(`  ${r.tablename.padEnd(20)} rls=${r.rls} forced=${r.forced}`);
  }

  // Without GUCs set, tenant-scoped queries must return zero rows.
  const fenced = await client.query(`SELECT count(*)::int AS n FROM conversations`);
  console.log('conversations visible without GUC =', fenced.rows[0].n, '(should be 0)');

  // With GUC set to the pilot tenant, we should see 0 conversations (no rows yet)
  // and at least 1 user.
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('app.tenant_id', (SELECT id::text FROM tenants WHERE name = 'Pilot Institution'), true)`
  );
  const u = await client.query(`SELECT count(*)::int AS n FROM users`);
  console.log('users visible with pilot tenant GUC =', u.rows[0].n, '(should be >= 1)');
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
