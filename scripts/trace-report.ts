/**
 * KAN-42 operator report: metadata and aggregates only, never conversation content.
 *
 *   npx vite-node scripts/trace-report.ts sample  --month 2026-10 --per-tenant 5 --actor <workosUserId> --out <file.json>
 *   npx vite-node scripts/trace-report.ts metrics --from 2026-10-01 --to 2026-11-01 --actor <workosUserId> [--out <file.json>]
 *
 * `sample` picks N random conversations per tenant started in the month (America/Lima) and
 * writes their metadata-only timelines to a local file. `metrics` prints the pilot metrics for
 * [from, to) (dates at 00:00 America/Lima). Connects as app_user through APP_DATABASE_URL; the
 * actor must be an active persisted platform superadmin. Run by hand; nothing is scheduled.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { closePool } from '../src/db/pool';
import { globalRepos } from '../src/repos/global';
import { computePilotMetrics } from '../src/services/trace/pilot-metrics';

const LIMA_DAY = /^\d{4}-\d{2}-\d{2}$/;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      month: { type: 'string' }, 'per-tenant': { type: 'string' }, from: { type: 'string' },
      to: { type: 'string' }, actor: { type: 'string' }, out: { type: 'string' },
    },
  });
  const mode = positionals[0];
  const actor = values.actor;
  if (!actor) throw new Error('--actor <workosUserId> is required (an active platform superadmin).');
  const trace = globalRepos().trace;

  if (mode === 'sample') {
    if (!values.month || !values.out) throw new Error('sample needs --month YYYY-MM and --out <file>.');
    const perTenant = Number(values['per-tenant'] ?? '5');
    const picked = await trace.sampleConversations(values.month, perTenant, actor);
    const timelines = [];
    for (const { tenantId, conversationId } of picked) {
      timelines.push(await trace.conversationMetadata(tenantId, conversationId, actor));
    }
    writeFileSync(values.out, JSON.stringify({ month: values.month, perTenant, generatedAt: new Date().toISOString(), timelines }, null, 2));
    console.log(`Wrote ${timelines.length} metadata-only timelines to ${values.out}.`);
    return;
  }
  if (mode === 'metrics') {
    if (!values.from || !values.to || !LIMA_DAY.test(values.from) || !LIMA_DAY.test(values.to)) {
      throw new Error('metrics needs --from and --to as YYYY-MM-DD.');
    }
    const from = `${values.from}T00:00:00-05:00`;
    const to = `${values.to}T00:00:00-05:00`;
    const report = { from, to, generatedAt: new Date().toISOString(), ...computePilotMetrics(await trace.metricSamples(from, to, actor)) };
    const json = JSON.stringify(report, null, 2);
    if (values.out) writeFileSync(values.out, json);
    console.log(json);
    return;
  }
  throw new Error('Usage: trace-report.ts sample|metrics (see the file header).');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closePool());
