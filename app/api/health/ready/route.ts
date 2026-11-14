/**
 * Readiness probe: 200 when PostgreSQL (as `app_user`) answers and, if
 * `REDIS_URL` is set, Redis answers PING; 503 otherwise.
 *
 * Public and unauthenticated (`proxy.ts` excludes this exact path), so the
 * body is limited to `ok | fail | skipped` per dependency. Failure details are
 * logged server-side only. See src/services/health/readiness.ts.
 */
import { checkReadiness } from '../../../../src/services/health/readiness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const report = await checkReadiness();
  return Response.json(report, {
    status: report.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
