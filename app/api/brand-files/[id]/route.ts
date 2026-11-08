/**
 * KAN-87: `GET /api/brand-files/<id>` streams the caller's own uploaded file. Foreign, missing and
 * malformed ids are the same 404. Served with inert headers (CSP sandbox, nosniff, inline) so an SVG
 * can never run script in the app's origin.
 */
import type { NextRequest } from 'next/server';
import { resolveIdentity } from '../../../../src/auth/resolve-identity';
import { repos } from '../../../../src/repos';
import { brandFileStorage, FILE_RESPONSE_HEADERS } from '../../../../src/services/storage/brand-upload';
import { loggerFor } from '../../../../src/services/logger';
import { isConversationId } from '../../../../src/conversations/selection';
import type { UUID } from '../../../../src/core/contracts';

const log = loggerFor('controller.brand-files');
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export const dynamic = 'force-dynamic';

const plain = (status: number, body: string) => new Response(body, { status, headers: NO_STORE });

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!isConversationId(id)) return plain(404, 'Not found');
  let identity;
  try {
    identity = await resolveIdentity();
  } catch {
    return plain(401, 'Unauthorized');
  }
  try {
    const file = await repos(identity.tenant, identity.user).brandFiles.get(id as UUID);
    if (!file) return plain(404, 'Not found');
    const bytes = await brandFileStorage().getObject(file.storageKey);
    if (!bytes) return plain(404, 'Not found');
    return new Response(new Blob([bytes as BlobPart]), { status: 200, headers: { ...FILE_RESPONSE_HEADERS, 'Content-Type': file.contentType, 'Content-Length': String(bytes.length) } });
  } catch (err) {
    log.error({ err, tenantId: identity.tenant.id, fileId: id }, 'brand_files.read_failed');
    return plain(503, 'Unavailable');
  }
}
