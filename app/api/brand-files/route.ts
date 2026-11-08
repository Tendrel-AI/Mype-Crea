/**
 * KAN-87 brand uploads: `POST /api/brand-files` (multipart: `brandId`, optional `productId`, `kind`,
 * `file`). A route handler, not a server action, because actions have a 1 MB body limit.
 *
 * The caller's identity comes from the session. A foreign, missing or archived brand/product is the
 * same 404. The type is decided by magic bytes (`sniffImage`); size is checked from `content-length`
 * first and again on the real bytes. The object is written first, then the row; when the row is
 * refused or fails the object is deleted (no orphans). Replacing the logo deletes the old object.
 */
import { randomUUID, createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { resolveIdentity } from '../../../src/auth/resolve-identity';
import { repos } from '../../../src/repos';
import { MAX_ASSETS } from '../../../src/repos/brand-files';
import { brandFileStorage, MAX_UPLOAD_BYTES, safeOriginalName, sniffImage } from '../../../src/services/storage/brand-upload';
import { loggerFor } from '../../../src/services/logger';
import { isConversationId } from '../../../src/conversations/selection';
import type { UUID } from '../../../src/core/contracts';

const log = loggerFor('controller.brand-files');
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
/** Multipart framing on top of the file itself. */
const MULTIPART_OVERHEAD = 64 * 1024;

export const dynamic = 'force-dynamic';

const reply = (status: number, message: string) => Response.json({ ok: false, message }, { status, headers: NO_STORE });
const NOT_FOUND = () => reply(404, 'No encontramos esta marca.');

export async function POST(request: NextRequest): Promise<Response> {
  let identity;
  try {
    identity = await resolveIdentity();
  } catch {
    return reply(401, 'Inicia sesión para continuar.');
  }
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return reply(411, 'No pudimos leer el tamaño del archivo.');
  if (length > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD) return reply(413, 'El archivo supera los 5 MB.');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, 'No pudimos leer el archivo.');
  }
  const brandId = form.get('brandId');
  const productRaw = form.get('productId');
  const productId = typeof productRaw === 'string' && productRaw ? productRaw : null;
  const kind = form.get('kind');
  const file = form.get('file');
  if (!isConversationId(brandId) || (productId !== null && !isConversationId(productId))) return NOT_FOUND();
  if ((kind !== 'logo' && kind !== 'asset') || !(file instanceof File)) return reply(400, 'Solicitud no válida.');
  if (kind === 'logo' && productId) return reply(400, 'El logo pertenece a la marca, no a un producto.');

  const child = log.child({ tenantId: identity.tenant.id, userId: identity.user.id, brandId });
  const owned = repos(identity.tenant, identity.user);
  try {
    if (!(await owned.brands.get(brandId as UUID))) return NOT_FOUND();
    if (productId) {
      const product = await owned.products.get(productId as UUID);
      if (!product || product.brandId !== brandId) return NOT_FOUND();
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) return reply(400, 'El archivo está vacío.');
    if (bytes.length > MAX_UPLOAD_BYTES) return reply(413, 'El archivo supera los 5 MB.');
    const image = sniffImage(bytes);
    if (!image) return reply(415, 'Sube una imagen PNG, JPG, WebP o un SVG sin scripts.');

    const fileId = randomUUID() as UUID;
    const storageKey = `tenants/${identity.tenant.id}/brands/${brandId}/files/${fileId}.${image.extension}`;
    const storage = brandFileStorage();
    await storage.putObject(storageKey, bytes, image.contentType);
    try {
      const added = await owned.brandFiles.add({
        id: fileId, brandId: brandId as UUID, productId: productId as UUID | null, kind, storageKey,
        contentType: image.contentType, byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), originalName: safeOriginalName(file.name),
      });
      if (!added.ok) {
        await storage.deleteObject(storageKey);
        return added.code === 'not_found' ? NOT_FOUND() : reply(409, `Cada marca o producto admite hasta ${MAX_ASSETS} archivos.`);
      }
      if (added.replacedStorageKey) {
        await storage.deleteObject(added.replacedStorageKey).catch((err) => child.error({ err }, 'brand_files.replaced_cleanup_failed'));
      }
      child.debug({ fileId, kind }, 'brand_files.stored');
      return Response.json({ ok: true, id: fileId, kind, originalName: added.file.originalName, url: `/api/brand-files/${fileId}` }, { status: 201, headers: NO_STORE });
    } catch (err) {
      await storage.deleteObject(storageKey).catch((cleanupErr) => child.error({ err: cleanupErr }, 'brand_files.orphan_cleanup_failed'));
      throw err;
    }
  } catch (err) {
    child.error({ err }, 'brand_files.upload_failed');
    return reply(503, 'No pudimos guardar el archivo. Inténtalo de nuevo.');
  }
}
