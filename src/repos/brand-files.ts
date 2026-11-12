/**
 * KAN-87 brand files: logo and asset uploads of one of the caller's active brands (or one of that
 * brand's products). Owner-only by RLS plus explicit predicates. The object is written to the bucket
 * BEFORE `add` (the route deletes it when `add` refuses or fails). `add` serializes per brand with an
 * advisory lock, enforces at most `MAX_ASSETS` assets per brand / per product, and replaces the single logo.
 */
import { MAX_BRAND_ASSETS } from '../core/brand-catalog';
import type { UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';

export const MAX_ASSETS = MAX_BRAND_ASSETS;
/** D32: lab-report PDFs per product. */
export const MAX_LAB_REPORTS = 5;

export type BrandFileKind = 'logo' | 'asset' | 'lab_report';

export interface BrandFileRow {
  readonly id: UUID;
  readonly brandId: UUID;
  readonly productId: UUID | null;
  readonly kind: BrandFileKind;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly originalName: string;
  readonly createdAt: string;
}

export interface LabReportRow {
  readonly fileId: UUID;
  readonly storageKey: string;
  readonly sha256: string;
  readonly originalName: string;
}

export interface NewBrandFile {
  readonly id: UUID;
  readonly brandId: UUID;
  readonly productId?: UUID | null;
  readonly kind: BrandFileKind;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly originalName: string;
}

export interface BrandFilesRepo {
  add(file: NewBrandFile): Promise<
    | { ok: true; file: BrandFileRow; replacedStorageKey?: string }
    | { ok: false; code: 'not_found' }
    | { ok: false; code: 'asset_limit_reached'; limit: number }
  >;
  /** D32: the product's lab reports (oldest first) with the hash recorded at upload. */
  listLabReports(productId: UUID): Promise<LabReportRow[]>;
  /** The caller's own file, or null when foreign or missing. */
  get(fileId: UUID): Promise<BrandFileRow | null>;
  /** Files of a brand's active owner, oldest first. */
  listByBrand(brandId: UUID): Promise<BrandFileRow[]>;
}

interface Db {
  id: UUID; brand_id: UUID; product_id: UUID | null; kind: BrandFileKind; storage_key: string;
  content_type: string; byte_size: number; original_name: string; created_at: Date;
}

const COLUMNS = 'id, brand_id, product_id, kind, storage_key, content_type, byte_size, original_name, created_at';

const toRow = (r: Db): BrandFileRow => ({
  id: r.id, brandId: r.brand_id, productId: r.product_id, kind: r.kind, storageKey: r.storage_key,
  contentType: r.content_type, byteSize: r.byte_size, originalName: r.original_name, createdAt: r.created_at.toISOString(),
});

export function brandFilesRepo(tenant: Tenant, user: User): BrandFilesRepo {
  return {
    async add(file) {
      return withTenantTransaction(tenant, user, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('brand_files:' || $1::text))`, [file.brandId]);
        const productId = file.productId ?? null;
        if (file.kind === 'lab_report' && !productId) return { ok: false, code: 'not_found' } as const;
        const owner = await tx.query(
          productId
            ? `SELECT 1 FROM products p JOIN brands b ON b.tenant_id = p.tenant_id AND b.id = p.brand_id
                WHERE p.id = $4 AND p.brand_id = $1 AND p.tenant_id = $2 AND p.user_id = $3 AND b.status = 'active'`
            : `SELECT 1 FROM brands WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'active'`,
          productId ? [file.brandId, tenant.id, user.id, productId] : [file.brandId, tenant.id, user.id],
        );
        if (owner.rows.length === 0) return { ok: false, code: 'not_found' } as const;
        let replacedStorageKey: string | undefined;
        if (file.kind === 'logo') {
          const old = await tx.query<{ storage_key: string }>(
            `DELETE FROM brand_files WHERE tenant_id = $1 AND user_id = $2 AND brand_id = $3 AND kind = 'logo' RETURNING storage_key`,
            [tenant.id, user.id, file.brandId],
          );
          replacedStorageKey = old.rows[0]?.storage_key;
        } else {
          const limit = file.kind === 'lab_report' ? MAX_LAB_REPORTS : MAX_ASSETS;
          const count = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM brand_files
              WHERE tenant_id = $1 AND brand_id = $2 AND kind = $4 AND product_id IS NOT DISTINCT FROM $3::uuid`,
            [tenant.id, file.brandId, productId, file.kind],
          );
          if ((count.rows[0]?.n ?? 0) >= limit) return { ok: false, code: 'asset_limit_reached', limit } as const;
        }
        const res = await tx.query<Db>(
          `INSERT INTO brand_files (id, tenant_id, user_id, brand_id, product_id, kind, storage_key, content_type, byte_size, sha256, original_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
          [file.id, tenant.id, user.id, file.brandId, productId, file.kind, file.storageKey, file.contentType, file.byteSize, file.sha256, file.originalName],
        );
        return { ok: true, file: toRow(res.rows[0]), replacedStorageKey } as const;
      });
    },

    async get(fileId) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<Db>(
          `SELECT ${COLUMNS} FROM brand_files WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
          [fileId, tenant.id, user.id],
        );
        return res.rows[0] ? toRow(res.rows[0]) : null;
      });
    },

    async listLabReports(productId) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ id: UUID; storage_key: string; sha256: string; original_name: string }>(
          `SELECT id, storage_key, sha256, original_name FROM brand_files
            WHERE tenant_id = $1 AND user_id = $2 AND product_id = $3 AND kind = 'lab_report' ORDER BY created_at, id`,
          [tenant.id, user.id, productId],
        );
        return res.rows.map((r) => ({ fileId: r.id, storageKey: r.storage_key, sha256: r.sha256, originalName: r.original_name }));
      });
    },

    async listByBrand(brandId) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<Db>(
          `SELECT ${COLUMNS} FROM brand_files WHERE tenant_id = $1 AND user_id = $2 AND brand_id = $3 ORDER BY created_at, id`,
          [tenant.id, user.id, brandId],
        );
        return res.rows.map(toRow);
      });
    },
  };
}
