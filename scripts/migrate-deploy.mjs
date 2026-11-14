// `npm run migrate:deploy`: applies pending migrations during a deploy (Railway pre-deploy
// command, KAN-83). Reads only MIGRATION_DATABASE_URL; see scripts/migrate-deploy-lib.mjs for the
// guards and docs/operations.md section 7 for the flow. Exit code 0 = applied or nothing pending;
// anything else aborts the deploy.
import { runner } from 'node-pg-migrate';
import { runDeployMigrations } from './migrate-deploy-lib.mjs';

const code = await runDeployMigrations({ env: process.env, runner });
process.exit(code);
