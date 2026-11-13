'use server';

/**
 * KAN-85 / KAN-87 controllers for brands and products (limits live in `limits.ts`, D38). Every call resolves
 * the live identity first; tenant and owner come only from it. Ids are UUID-checked and `attributes`
 * go through the catalog validator (`src/core/brand-catalog.ts`) before anything reaches a repository. A foreign,
 * missing or archived brand always gets the same not-found answer.
 */
import { resolveIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import type { ProductRow } from '../../src/repos/products';
import type { UUID } from '../../src/core/contracts';
import {
  BRAND_NOT_FOUND_MESSAGE,
  NEW_CONVERSATION_FAILED_MESSAGE,
  PRODUCT_NOT_FOUND_MESSAGE,
  createOwnedBrand,
  createOwnedProduct,
  invalidFields,
  isConversationId,
  listOwnedBrands,
  stripServerFlags,
  type BrandFileView,
  type BrandListEntry,
  type NewOwnedConversation,
} from '../../src/conversations/selection';
import { validateAttributes } from '../../src/core/brand-catalog';
import type { BrandFileRow } from '../../src/repos/brand-files';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('controller.brands');

const FAILED = 'No pudimos completar la acción. Inténtalo de nuevo.';
const NOT_FOUND = { ok: false, code: 'brand_not_found', message: BRAND_NOT_FOUND_MESSAGE } as const;
const PRODUCT_NOT_FOUND = { ok: false, code: 'product_not_found', message: PRODUCT_NOT_FOUND_MESSAGE } as const;

type Failed = { readonly ok: false; readonly code: 'failed'; readonly message: string };
type InvalidFields = { readonly ok: false; readonly code: 'invalid_input'; readonly message: string; readonly fieldErrors: Record<string, string> };

/** «Crear marca» / «Ya tengo una marca»: validate on the server, then a brand plus its first conversation. */
export async function createBrandAction(input: {
  readonly attributes: Record<string, unknown>;
  readonly imported?: boolean;
}): Promise<NewOwnedConversation> {
  try {
    return await createOwnedBrand(await resolveIdentity(), { attributes: input?.attributes, imported: input?.imported === true });
  } catch (error) {
    log.error({ err: error }, 'brands.create_failed');
    return { ok: false, code: 'configuration_unavailable', message: NEW_CONVERSATION_FAILED_MESSAGE };
  }
}

export type EditBrandResult = { readonly ok: true; readonly name: string | null } | typeof NOT_FOUND | InvalidFields | Failed;

/** «Editar marca»: a partial patch; the merged attributes are validated again, so required fields stay required. */
export async function updateBrandAction(input: {
  readonly brandId: string;
  readonly attributes: Record<string, unknown>;
}): Promise<EditBrandResult> {
  if (!isConversationId(input?.brandId)) return NOT_FOUND;
  const verdict = validateAttributes('brand', stripServerFlags(input.attributes), { partial: true });
  if (!verdict.ok) return invalidFields(verdict.errors);
  try {
    const identity = await resolveIdentity();
    const updated = await repos(identity.tenant, identity.user).brands.update(input.brandId as UUID, verdict);
    if (updated.ok) return updated;
    return updated.code === 'invalid_input' ? invalidFields(updated.errors) : NOT_FOUND;
  } catch (error) {
    log.error({ err: error }, 'brands.update_failed');
    return { ok: false, code: 'failed', message: FAILED };
  }
}

export type BrandDetailResult =
  | { readonly ok: true; readonly brandId: UUID; readonly name: string | null; readonly attributes: Record<string, unknown>; readonly files: ReadonlyArray<BrandFileView> }
  | typeof NOT_FOUND
  | Failed;

const fileView = (file: BrandFileRow): BrandFileView => ({
  id: file.id, kind: file.kind, productId: file.productId, originalName: file.originalName, byteSize: file.byteSize, url: `/api/brand-files/${file.id}`,
});

/** The brand's stored values and files, to prefill «Editar marca» and «Nuevo producto» (inherited hints). */
export async function getBrandAction(input: { readonly brandId: string }): Promise<BrandDetailResult> {
  if (!isConversationId(input?.brandId)) return NOT_FOUND;
  try {
    const identity = await resolveIdentity();
    const owned = repos(identity.tenant, identity.user);
    const brand = await owned.brands.get(input.brandId as UUID);
    if (!brand) return NOT_FOUND;
    const files = await owned.brandFiles.listByBrand(brand.id);
    return { ok: true, brandId: brand.id, name: brand.name, attributes: brand.attributes, files: files.filter((f) => !f.productId).map(fileView) };
  } catch (error) {
    log.error({ err: error }, 'brands.get_failed');
    return { ok: false, code: 'failed', message: FAILED };
  }
}

export type BrandListResult =
  | { readonly ok: true; readonly brands: ReadonlyArray<BrandListEntry> }
  | { readonly ok: false; readonly message: string };

export async function listBrandsAction(): Promise<BrandListResult> {
  try {
    return { ok: true, brands: await listOwnedBrands(await resolveIdentity()) };
  } catch {
    return { ok: false, message: FAILED };
  }
}

/** Archive frees the brand's slot and hides its conversations; there is no unarchive. */
export async function archiveBrandAction(input: { readonly brandId: string }): Promise<{ readonly ok: true } | typeof NOT_FOUND | { readonly ok: false; readonly code: 'failed'; readonly message: string }> {
  if (!isConversationId(input?.brandId)) return NOT_FOUND;
  try {
    const identity = await resolveIdentity();
    return (await repos(identity.tenant, identity.user).brands.archive(input.brandId as UUID))
      ? { ok: true }
      : NOT_FOUND;
  } catch (error) {
    log.error({ err: error }, 'brands.archive_failed');
    return { ok: false, code: 'failed', message: FAILED };
  }
}

export type ProductDetailResult =
  | { readonly ok: true; readonly productId: UUID; readonly brandId: UUID; readonly attributes: Record<string, unknown>; readonly brandAttributes: Record<string, unknown>; readonly files: ReadonlyArray<BrandFileView> }
  | typeof PRODUCT_NOT_FOUND
  | Failed;

/** The product's stored values (plus the brand's, for «Heredado de la marca») and its files. */
export async function getProductAction(input: { readonly productId: string }): Promise<ProductDetailResult> {
  if (!isConversationId(input?.productId)) return PRODUCT_NOT_FOUND;
  try {
    const identity = await resolveIdentity();
    const owned = repos(identity.tenant, identity.user);
    const product = await owned.products.get(input.productId as UUID);
    const brand = product && await owned.brands.get(product.brandId);
    if (!product || !brand) return PRODUCT_NOT_FOUND;
    const files = await owned.brandFiles.listByBrand(brand.id);
    return {
      ok: true, productId: product.id, brandId: product.brandId, attributes: product.attributes,
      brandAttributes: brand.attributes, files: files.filter((f) => f.productId === product.id && f.kind !== 'lab_report').map(fileView),
    };
  } catch (error) {
    log.error({ err: error }, 'products.get_failed');
    return { ok: false, code: 'failed', message: FAILED };
  }
}

/** «Nuevo producto»: validate on the server, then the product plus its first conversation (product limit checked). */
export async function createProductAction(input: {
  readonly brandId: string;
  readonly attributes: Record<string, unknown>;
}): Promise<NewOwnedConversation> {
  if (!isConversationId(input?.brandId)) return NOT_FOUND;
  try {
    return await createOwnedProduct(await resolveIdentity(), { brandId: input.brandId as UUID, attributes: input.attributes });
  } catch (error) {
    log.error({ err: error }, 'products.create_failed');
    return { ok: false, code: 'configuration_unavailable', message: NEW_CONVERSATION_FAILED_MESSAGE };
  }
}

export type EditProductResult = { readonly ok: true; readonly name: string | null } | typeof PRODUCT_NOT_FOUND | InvalidFields | Failed;

/** «Editar producto»: same partial-then-merged validation as the brand. */
export async function updateProductAction(input: {
  readonly productId: string;
  readonly attributes: Record<string, unknown>;
}): Promise<EditProductResult> {
  if (!isConversationId(input?.productId)) return PRODUCT_NOT_FOUND;
  const verdict = validateAttributes('product', input.attributes, { partial: true });
  if (!verdict.ok) return invalidFields(verdict.errors);
  try {
    const identity = await resolveIdentity();
    const updated = await repos(identity.tenant, identity.user).products.update(input.productId as UUID, verdict);
    if (updated.ok) return updated;
    return updated.code === 'invalid_input' ? invalidFields(updated.errors) : PRODUCT_NOT_FOUND;
  } catch (error) {
    log.error({ err: error }, 'products.update_failed');
    return { ok: false, code: 'failed', message: FAILED };
  }
}

export type ListProductsResult =
  | { readonly ok: true; readonly products: ReadonlyArray<ProductRow> }
  | { readonly ok: false; readonly code: 'brand_not_found' | 'failed'; readonly message: string };

export async function listProductsAction(input: { readonly brandId: string }): Promise<ListProductsResult> {
  if (!isConversationId(input?.brandId)) return NOT_FOUND;
  try {
    const identity = await resolveIdentity();
    return { ok: true, products: await repos(identity.tenant, identity.user).products.listByBrand(input.brandId as UUID) };
  } catch {
    return { ok: false, code: 'failed', message: FAILED };
  }
}
