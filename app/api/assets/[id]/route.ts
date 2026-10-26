/**
 * Authorized access to a stored deliverable image (KAN-52).
 *
 * `GET /api/assets/<deliverableId>` is the only URL a client ever gets for an
 * image in the private bucket. Protected by the `proxy.ts` matcher (WorkOS
 * session). The route resolves the identity, reads the object key through
 * the tenant-scoped repository (RLS: tenant; the query: owner only), and
 * answers `302` to a presigned GET URL valid for PRESIGNED_URL_TTL_SECONDS.
 * Image bytes never pass through the app.
 *
 * Unknown, other-tenant, other-owner and never-stored deliverables are all
 * the same `404`, so the response does not reveal whether a row exists.
 */
import type { NextRequest } from 'next/server';
import { resolveIdentity } from '../../../../src/auth/resolve-identity';
import { repos } from '../../../../src/repos';
import { getObjectStorage, PRESIGNED_URL_TTL_SECONDS } from '../../../../src/services/storage';
import { loggerFor } from '../../../../src/services/logger';
import type { UUID } from '../../../../src/core/contracts';

const log = loggerFor('controller.assets');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export const dynamic = 'force-dynamic';

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: NO_STORE });
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return plain(404, 'Not found');

  let identity;
  try {
    identity = await resolveIdentity();
  } catch {
    return plain(401, 'Unauthorized');
  }
  const child = log.child({ tenantId: identity.tenant.id, userId: identity.user.id, deliverableId: id });

  let storageKey: string | null;
  try {
    storageKey = await repos(identity.tenant, identity.user).deliverables.findOwnStorageKey(id as UUID);
  } catch (err) {
    child.error({ err }, 'assets.lookup_failed');
    return plain(503, 'Unavailable');
  }
  if (!storageKey) return plain(404, 'Not found');

  try {
    const storage = getObjectStorage();
    if (!storage) {
      child.error('assets.storage_disabled_for_stored_row');
      return plain(503, 'Unavailable');
    }
    const location = await storage.presignGet(storageKey, PRESIGNED_URL_TTL_SECONDS);
    return new Response(null, { status: 302, headers: { ...NO_STORE, Location: location } });
  } catch (err) {
    child.error({ err }, 'assets.presign_failed');
    return plain(503, 'Unavailable');
  }
}
