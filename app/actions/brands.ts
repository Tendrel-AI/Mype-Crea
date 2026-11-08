'use server';

/**
 * KAN-85 controllers for brands, products and the two tenant-admin limits. Every call resolves
 * the live identity first; tenant and owner come only from it. Ids are UUID-checked and
 * `attributes` is a size-capped plain object before anything reaches a repository. A foreign,
 * missing or archived brand always gets the same not-found answer.
 */
import { requireTenantAdmin, resolveIdentity, TenantAdminRequiredError } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import type { BrandLimits } from '../../src/repos/brands';
import type { ProductRow } from '../../src/repos/products';
import { NotTenantAdminError } from '../../src/repos/tenant-accounts';
import type { UUID } from '../../src/core/contracts';
import {
  BRAND_NOT_FOUND_MESSAGE,
  NEW_CONVERSATION_FAILED_MESSAGE,
  createOwnedBrand,
  isConversationId,
  listOwnedBrands,
  type BrandListEntry,
  type NewOwnedConversation,
} from '../../src/conversations/selection';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('controller.brands');

const FAILED = 'No pudimos completar la acción. Inténtalo de nuevo.';
const NOT_FOUND = { ok: false, code: 'brand_not_found', message: BRAND_NOT_FOUND_MESSAGE } as const;
export const MAX_ATTRIBUTES_BYTES = 16 * 1024;
export const MAX_NAME_LENGTH = 120;
export const MAX_LIMIT = 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** `undefined` attributes mean `{}`; anything else must be a plain object within the size cap. */
function validAttributes(value: unknown): value is Record<string, unknown> | undefined {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_ATTRIBUTES_BYTES;
  } catch {
    return false;
  }
}

const validName = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && value.length <= MAX_NAME_LENGTH);

/** «Crear marca»: a brand plus its first conversation, or the brand-limit refusal. */
export async function createBrandAction(): Promise<NewOwnedConversation> {
  try {
    return await createOwnedBrand(await resolveIdentity());
  } catch (error) {
    log.error({ err: error }, 'brands.create_failed');
    return { ok: false, code: 'configuration_unavailable', message: NEW_CONVERSATION_FAILED_MESSAGE };
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

export type CreateProductResult =
  | { readonly ok: true; readonly product: ProductRow }
  | typeof NOT_FOUND
  | { readonly ok: false; readonly code: 'invalid_input' | 'failed'; readonly message: string };

export async function createProductAction(input: {
  readonly brandId: string;
  readonly name?: string;
  readonly attributes?: Record<string, unknown>;
}): Promise<CreateProductResult> {
  if (!isConversationId(input?.brandId)) return NOT_FOUND;
  if (!validName(input.name) || !validAttributes(input.attributes)) {
    return { ok: false, code: 'invalid_input', message: 'Revisa los datos del producto e inténtalo de nuevo.' };
  }
  try {
    const identity = await resolveIdentity();
    const created = await repos(identity.tenant, identity.user).products.create({
      brandId: input.brandId as UUID, name: input.name?.trim() || null, attributes: input.attributes,
    });
    return created.ok ? created : NOT_FOUND;
  } catch (error) {
    log.error({ err: error }, 'products.create_failed');
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

export type BrandLimitsResult =
  | ({ readonly ok: true } & BrandLimits)
  | { readonly ok: false; readonly code: 'not_admin' | 'invalid_input' | 'failed'; readonly message: string };

const NOT_ADMIN = { ok: false, code: 'not_admin', message: 'No tienes permiso para cambiar los límites de esta organización.' } as const;

export async function getBrandLimitsAction(): Promise<BrandLimitsResult> {
  try {
    const identity = await resolveIdentity();
    return { ok: true, ...(await repos(identity.tenant, identity.user).brands.getLimits()) };
  } catch {
    return { ok: false, code: 'failed', message: FAILED };
  }
}

const validLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LIMIT;

/** Tenant admin only: checked here from the live identity and again in the database. */
export async function updateBrandLimitsAction(input: {
  readonly maxBrandsPerUser: number;
  readonly maxConversationsPerBrand: number;
}): Promise<BrandLimitsResult> {
  let identity;
  try {
    identity = await requireTenantAdmin();
  } catch (error) {
    if (error instanceof TenantAdminRequiredError) {
      log.warn({ tenantId: error.identity.tenant.id, userId: error.identity.user.id }, 'brands.limits.refused_not_admin');
      return NOT_ADMIN;
    }
    return { ok: false, code: 'failed', message: FAILED };
  }
  if (!validLimit(input?.maxBrandsPerUser) || !validLimit(input?.maxConversationsPerBrand)) {
    return { ok: false, code: 'invalid_input', message: `Los límites deben ser números enteros entre 0 y ${MAX_LIMIT}.` };
  }
  const limits = { maxBrandsPerUser: input.maxBrandsPerUser, maxConversationsPerBrand: input.maxConversationsPerBrand };
  try {
    await repos(identity.tenant, identity.user).brands.setLimits(limits);
    log.info({ tenantId: identity.tenant.id, userId: identity.user.id, ...limits }, 'brands.limits.updated');
    return { ok: true, ...limits };
  } catch (error) {
    if (error instanceof NotTenantAdminError) return NOT_ADMIN;
    log.error({ err: error }, 'brands.limits.failed');
    return { ok: false, code: 'failed', message: FAILED };
  }
}
