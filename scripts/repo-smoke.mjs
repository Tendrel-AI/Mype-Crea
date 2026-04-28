// node --env-file=.env.local scripts/repo-smoke.mjs
import { randomUUID } from 'node:crypto';
import pg from 'pg';

async function main() {
  // 1. Look up pilot ids via super.
  const su = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await su.connect();
  const t = await su.query(`SELECT id FROM tenants WHERE name='Pilot Institution'`);
  const u = await su.query(`SELECT id FROM users WHERE tenant_id=$1`, [t.rows[0].id]);
  const tenantId = t.rows[0].id;
  const userId = u.rows[0].id;
  await su.end();
  console.log('pilot:', { tenantId, userId });

  // 2. As app_user, attempt to insert + read a conversation.
  const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
  await app.connect();
  const cid = randomUUID();
  console.log('cid:', cid);
  try {
    await app.query('BEGIN');
    console.log('began tx');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await app.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    console.log('GUCs set');
    const ins = await app.query(
      `INSERT INTO conversations (id, tenant_id, user_id) VALUES ($1, $2, $3) RETURNING id`,
      [cid, tenantId, userId],
    );
    console.log('inserted:', ins.rows);
    const sel = await app.query(`SELECT id, agent_states FROM conversations WHERE id=$1`, [cid]);
    console.log('selected:', sel.rows);
    await app.query('ROLLBACK');
    console.log('rolled back ok');
  } catch (e) {
    console.error('app_user failed:', e);
    try { await app.query('ROLLBACK'); } catch {}
  } finally {
    await app.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
