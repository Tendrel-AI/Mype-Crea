// CI-only check that migrations create a usable app_user without BYPASSRLS.
import pg from 'pg';

const { DATABASE_URL, APP_DATABASE_URL } = process.env;
if (!DATABASE_URL || !APP_DATABASE_URL) {
  throw new Error('DATABASE_URL and APP_DATABASE_URL are required');
}

const owner = new pg.Client({ connectionString: DATABASE_URL });
const app = new pg.Client({ connectionString: APP_DATABASE_URL });

try {
  await owner.connect();
  const role = await owner.query(
    `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'`,
  );
  if (!role.rows[0]?.rolcanlogin || role.rows[0]?.rolbypassrls) {
    throw new Error('app_user must be able to log in and must not have BYPASSRLS');
  }

  await app.connect();
  const identity = await app.query('SELECT current_user');
  if (identity.rows[0]?.current_user !== 'app_user') {
    throw new Error('APP_DATABASE_URL must connect as app_user');
  }

  console.log('Verified app_user login and connection; BYPASSRLS is disabled.');
} finally {
  await Promise.all([owner.end(), app.end()]);
}
