/**
 * KAN-85 / KAN-87 products. Each product belongs to one of the caller's ACTIVE brands; a foreign,
 * missing or archived brand yields `brand_not_found`. Owner-only by RLS plus the explicit predicates below.
 * Creation is limited per brand (limit profile key `products.per_brand`, D38): the owner's active brand row is
 * locked FOR UPDATE, its products are counted, and over the limit a typed refusal comes back.
 * With `firstConversation` the product's first conversation is pinned in the same transaction.
 */
import type { UUID } from '../core/contracts';
import type { AiConversationPin } from './models';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { updateAttributesInTx, type AttributePatch } from './attributes';
import { readCountLimits, type BrandNotFound, type FirstConversation, type InvalidAttributes } from './brands';
import { pinConversationInTx } from './conversations';
import { checkLimit } from '../core/limits/rules';

const log = loggerFor('repos.products');

export interface ProductRow {
  readonly id: UUID;
  readonly brandId: UUID;
  readonly name: string | null;
  readonly attributes: Record<string, unknown>;
  readonly createdAt: string;
  /** KAN-111: the product's own chat, set by `listActive`; null when it has none. */
  readonly chatConversationId?: UUID | null;
}

export type ProductLimitRefusal = { readonly ok: false; readonly code: 'product_limit_reached'; readonly limit: number };
type ProductNotFound = { readonly ok: false; readonly code: 'product_not_found' };

export interface ProductsRepo {
  /** `name` and `attributes` must already be validated (`validateAttributes('product', …)`). */
  create(input: { brandId: UUID; name?: string | null; attributes?: Record<string, unknown>; firstConversation?: FirstConversation }):
    Promise<{ ok: true; product: ProductRow; pin?: AiConversationPin } | BrandNotFound | ProductLimitRefusal>;
  get(productId: UUID): Promise<ProductRow | null>;
  update(productId: UUID, patch: AttributePatch): Promise<{ ok: true; name: string | null } | ProductNotFound | InvalidAttributes>;
  /** Newest first; empty for a foreign or missing brand. */
  listByBrand(brandId: UUID): Promise<ProductRow[]>;
  /** Every product of the caller's active brands, oldest first. */
  listActive(): Promise<ProductRow[]>;
}

interface ProductRowDb {
  id: UUID;
  brand_id: UUID;
  name: string | null;
  attributes: Record<string, unknown>;
  created_at: Date;
}

const toRow = (row: ProductRowDb): ProductRow => ({
  id: row.id, brandId: row.brand_id, name: row.name, attributes: row.attributes, createdAt: row.created_at.toISOString(),
});

export function productsRepo(tenant: Tenant, user: User): ProductsRepo {
  return {
    async create(input) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const brand = await tx.query(
          `SELECT id FROM brands WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'active' FOR UPDATE`,
          [input.brandId, tenant.id, user.id],
        );
        if (brand.rows.length === 0) return { ok: false, code: 'brand_not_found' } as const;
        const limits = await readCountLimits(tx, tenant, user);
        const count = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND brand_id = $2`,
          [tenant.id, input.brandId],
        );
        const refusal = checkLimit(limits, { kind: 'product' }, count.rows[0]?.n ?? 0);
        if (refusal) {
          log.info({ tenantId: tenant.id, brandId: input.brandId, limit: refusal.limit }, 'products.create.limit_reached');
          return { ok: false, code: 'product_limit_reached', limit: refusal.limit } as const;
        }
        const res = await tx.query<ProductRowDb>(
          `INSERT INTO products (tenant_id, brand_id, user_id, name, attributes)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING id, brand_id, name, attributes, created_at`,
          [tenant.id, input.brandId, user.id, input.name ?? null, JSON.stringify(input.attributes ?? {})],
        );
        const product = toRow(res.rows[0]);
        log.debug({ tenantId: tenant.id, brandId: input.brandId, productId: product.id }, 'products.create.ok');
        if (!input.firstConversation) return { ok: true, product } as const;
        // Same transaction: if the conversation cannot be pinned, the product is not created either.
        const pin = await pinConversationInTx(tx, tenant, user, input.firstConversation, input.brandId, product.id);
        return { ok: true, product, pin } as const;
      });
    },

    async get(productId) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<ProductRowDb>(
          `SELECT p.id, p.brand_id, p.name, p.attributes, p.created_at FROM products p
             JOIN brands b ON b.tenant_id = p.tenant_id AND b.id = p.brand_id AND b.status = 'active'
            WHERE p.id = $1 AND p.tenant_id = $2 AND p.user_id = $3`,
          [productId, tenant.id, user.id],
        );
        return res.rows[0] ? toRow(res.rows[0]) : null;
      });
    },

    async update(productId, patch) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const result = await updateAttributesInTx(tx, { level: 'product', id: productId, tenantId: tenant.id, userId: user.id, patch });
        if (result.ok) return { ok: true, name: result.name } as const;
        return result.code === 'not_found' ? { ok: false, code: 'product_not_found' } as const : result;
      });
    },

    async listByBrand(brandId) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<ProductRowDb>(
          `SELECT id, brand_id, name, attributes, created_at FROM products
            WHERE tenant_id = $1 AND user_id = $2 AND brand_id = $3
            ORDER BY created_at DESC, id DESC`,
          [tenant.id, user.id, brandId],
        );
        return res.rows.map(toRow);
      });
    },

    async listActive() {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<ProductRowDb & { chat_id: UUID | null }>(
          `SELECT p.id, p.brand_id, p.name, p.attributes, p.created_at,
                  (SELECT c.id FROM conversations c
                    WHERE c.tenant_id = p.tenant_id AND c.product_id = p.id AND c.status = 'active'
                    ORDER BY c.started_at, c.id LIMIT 1) AS chat_id
             FROM products p
             JOIN brands b ON b.tenant_id = p.tenant_id AND b.id = p.brand_id AND b.status = 'active'
            WHERE p.tenant_id = $1 AND p.user_id = $2
            ORDER BY p.created_at, p.id`,
          [tenant.id, user.id],
        );
        return res.rows.map((row) => ({ ...toRow(row), chatConversationId: row.chat_id }));
      });
    },
  };
}
