/**
 * Liveness probe: the Next.js process is up and serving requests.
 *
 * Deliberately touches no dependency (database, Redis, WorkOS). `proxy.ts`
 * excludes this exact path from the AuthKit middleware, so it needs no
 * session. Readiness lives at `/api/health/ready`.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
