/**
 * Readiness evaluation behind `GET /api/health/ready`.
 *
 * The report carries only a status per dependency. Error messages can contain
 * hostnames, roles, or connection details, so they go to the server log and
 * never into the report.
 */
import { healthRepo } from '../../repos/health';
import { probeRedis } from '../redis';
import { loggerFor } from '../logger';
import { checkActivePrompts } from '../prompts';

const log = loggerFor('services.health');

/** Per-dependency budget. Checks run in parallel, so the probe answers within about this long. */
export const READINESS_TIMEOUT_MS = 2_000;

export type DependencyStatus = 'ok' | 'fail';

export interface ReadinessReport {
  readonly status: DependencyStatus;
  readonly checks: {
    readonly database: DependencyStatus;
    /** `skipped` when `REDIS_URL` is not set: Redis is optional for this app. */
    readonly redis: DependencyStatus | 'skipped';
    /** D22: every active prompt version (`PROMPT_<KEY>` or latest) exists and matches its lock hash. */
    readonly prompts: DependencyStatus;
  };
}

export async function checkReadiness(): Promise<ReadinessReport> {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const prompts = checkPrompts();
  const status: DependencyStatus = database === 'ok' && redis !== 'fail' && prompts === 'ok' ? 'ok' : 'fail';
  if (status === 'fail') log.warn({ database, redis, prompts }, 'health.ready.not_ready');
  return { status, checks: { database, redis, prompts } };
}

function checkPrompts(): DependencyStatus {
  const problems = checkActivePrompts();
  if (problems.length === 0) return 'ok';
  log.error({ dependency: 'prompts', problems }, 'health.ready.dependency_failed');
  return 'fail';
}

async function checkDatabase(): Promise<DependencyStatus> {
  try {
    await healthRepo().pingDatabase(READINESS_TIMEOUT_MS);
    return 'ok';
  } catch (error) {
    log.error({ dependency: 'database', err: describe(error) }, 'health.ready.dependency_failed');
    return 'fail';
  }
}

async function checkRedis(): Promise<DependencyStatus | 'skipped'> {
  try {
    const result = await probeRedis(READINESS_TIMEOUT_MS);
    return result === 'not_configured' ? 'skipped' : 'ok';
  } catch (error) {
    log.error({ dependency: 'redis', err: describe(error) }, 'health.ready.dependency_failed');
    return 'fail';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
