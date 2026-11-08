/**
 * KAN-85 products. Each product belongs to one of the caller's ACTIVE brands; a foreign, missing or
 * archived brand yields `brand_not_found`. Owner-only by RLS plus the explicit predicates below.
 */
import type { UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';

export interface ProductRow {
  readonly id: UUID;
  readonly brandId: UUID;
  readonly name: string | null;
  readonly attributes: Record<string, unknown>;
  readonly createdAt: string;
}

export interface ProductsRepo {
  create(input: { brandId: UUID; name?: string | null; attributes?: Record<string, unknown> }):
    Promise<{ ok: true; product: ProductRow } | { ok: false; code: 'brand_not_found' }>;
  /** Newest first; empty for a foreign or missing brand. */
  listByBrand(brandId: UUID): Promise<ProductRow[]>;
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
        const res = await tx.query<ProductRowDb>(
          `INSERT INTO products (tenant_id, brand_id, user_id, name, attributes)
           SELECT b.tenant_id, b.id, b.user_id, $4, $5::jsonb
             FROM brands b
            WHERE b.id = $1 AND b.tenant_id = $2 AND b.user_id = $3 AND b.status = 'active'
           RETURNING id, brand_id, name, attributes, created_at`,
          [input.brandId, tenant.id, user.id, input.name ?? null, JSON.stringify(input.attributes ?? {})],
        );
        return res.rows[0] ? { ok: true, product: toRow(res.rows[0]) } as const : { ok: false, code: 'brand_not_found' } as const;
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
  };
}
