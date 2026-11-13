/**
 * D42 monthly job: computes (and stores, if missing) the current-month forecast snapshot of every active tenant.
 *
 *   npx vite-node scripts/forecast-snapshot.ts
 *
 * Connects as app_user through APP_DATABASE_URL in global transactions. Idempotent: re-running in the same
 * month only reads the stored snapshots.
 */
import { closePool } from '../src/db/pool';
import { globalRepos } from '../src/repos/global';

async function main(): Promise<void> {
  const repos = globalRepos();
  const tenants = (await repos.organizations.list()).filter((t) => t.status === 'active');
  let failed = 0;
  for (const t of tenants) {
    try {
      const { current } = await repos.forecast.forTenant(t.tenantId);
      console.log(`${t.tenantId} ${current.month} expected=${current.forecast.expectedSpendUsd} weight=${current.forecast.weight}`);
    } catch (error) {
      failed += 1;
      console.error(`${t.tenantId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`forecast snapshots: ${tenants.length - failed}/${tenants.length} ok`);
  if (failed > 0) process.exitCode = 1;
}

main().finally(() => closePool());
