/**
 * KAN-85 / KAN-87 brands. A user creates a brand (with validated typed attributes) before chatting;
 * every new conversation belongs to a brand. Two count limits (limit profile keys `brands.per_user` and
 * `products.per_brand`, D38; decided by `src/core/limits/rules.ts`) are enforced inside the same transaction as the insert:
 *  - brands: a per-(tenant, user) advisory lock serializes creators, then active brands are counted;
 *  - products: see `products.ts` (the owner's active brand row is locked, then its products counted).
 * Conversations per brand are NOT limited (KAN-87; cost is bounded by KAN-43 usage limits).
 * Over the limit returns a typed refusal (never a throw). Archived brands do not count and take no
 * new conversations or edits. Lowering a limit below the current count only blocks new creation.
 * The limits change only through the limit profile (`app.set_limit_profile_value`, see `src/repos/limits.ts`).
 */
import type { AiConversationPin } from './models';
import type { UUID } from '../core/contracts';
import type { AgentFieldSchema } from '../core/orchestrator/in-memory-store';
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { businessNameFromAgentStates, pinConversationInTx } from './conversations';
import { readEffectiveLimits } from './limits';
import { checkLimit } from '../core/limits/rules';
import { FIXED_CATALOG, withDefaults } from '../core/limits/catalog';
import { updateAttributesInTx, type AttributePatch } from './attributes';

const log = loggerFor('repos.brands');

export interface BrandRow {
  readonly id: UUID;
  /** The stored name, else the business name of the brand's newest conversation, else null. */
  readonly name: string | null;
  readonly attributes: Record<string, unknown>;
  readonly createdAt: string;
}

export type LimitRefusal = { readonly ok: false; readonly code: 'brand_limit_reached'; readonly limit: number };
export type BrandNotFound = { readonly ok: false; readonly code: 'brand_not_found' };
export type ProductNotFound = { readonly ok: false; readonly code: 'product_not_found' };
export type InvalidAttributes = { readonly ok: false; readonly code: 'invalid_input'; readonly errors: Record<string, string> };

export interface FirstConversation {
  readonly conversationId: UUID;
  readonly schemas: ReadonlyArray<AgentFieldSchema>;
}

export interface BrandsRepo {
  /** Create an active brand within the limit; with `firstConversation` it is pinned in the same transaction. */
  create(input: { name?: string | null; attributes?: Record<string, unknown>; firstConversation?: FirstConversation }):
    Promise<{ ok: true; brandId: UUID; pin?: AiConversationPin } | LimitRefusal>;
  /** Add a conversation to the caller's active brand, optionally under one of that brand's products. */
  createConversation(input: FirstConversation & { brandId: UUID; productId?: UUID }):
    Promise<{ ok: true; pin: AiConversationPin } | BrandNotFound | ProductNotFound>;
  /** The caller's active brand, or null when it is foreign, missing or archived. */
  get(brandId: UUID): Promise<BrandRow | null>;
  /** Apply a validated patch; the merged attributes are validated again (required fields stay required). */
  update(brandId: UUID, patch: AttributePatch): Promise<{ ok: true; name: string | null } | BrandNotFound | InvalidAttributes>;
  /** The caller's active brands, oldest first. */
  listActive(): Promise<BrandRow[]>;
  /** Archive the caller's active brand; false when it is foreign, missing or already archived. */
  archive(brandId: UUID): Promise<boolean>;
}

/** Effective count limits (fixed catalog keys completed with code defaults) inside the caller's transaction. */
export async function readCountLimits(tx: TxClient, tenant: Tenant, user: User) {
  return withDefaults(FIXED_CATALOG, await readEffectiveLimits(tx, tenant, user));
}

export function brandsRepo(tenant: Tenant, user: User): BrandsRepo {
  return {
    async create(input) {
      return withTenantTransaction(tenant, user, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('brands:' || $1::text || ':' || $2::text))`, [tenant.id, user.id]);
        const limits = await readCountLimits(tx, tenant, user);
        const count = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM brands WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
          [tenant.id, user.id],
        );
        const refusal = checkLimit(limits, { kind: 'brand' }, count.rows[0]?.n ?? 0);
        if (refusal) {
          log.info({ tenantId: tenant.id, userId: user.id, limit: refusal.limit }, 'brands.create.limit_reached');
          return { ok: false, code: 'brand_limit_reached', limit: refusal.limit } as const;
        }
        const inserted = await tx.query<{ id: UUID }>(
          `INSERT INTO brands (tenant_id, user_id, name, attributes) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
          [tenant.id, user.id, input.name ?? null, JSON.stringify(input.attributes ?? {})],
        );
        const brandId = inserted.rows[0].id;
        log.debug({ tenantId: tenant.id, userId: user.id, brandId }, 'brands.create.ok');
        if (!input.firstConversation) return { ok: true, brandId } as const;
        // Same transaction: if the conversation cannot be pinned, the brand is not created either.
        const pin = await pinConversationInTx(tx, tenant, user, input.firstConversation, brandId);
        return { ok: true, brandId, pin } as const;
      });
    },

    async createConversation(input) {
      return withTenantTransaction(tenant, user, async (tx) => {
        // FOR SHARE keeps a concurrent archive from slipping between this check and the insert.
        const brand = await tx.query(
          `SELECT id FROM brands WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'active' FOR SHARE`,
          [input.brandId, tenant.id, user.id],
        );
        if (brand.rows.length === 0) return { ok: false, code: 'brand_not_found' } as const;
        if (input.productId) {
          // The DB FKs also enforce this; checking first gives a typed refusal instead of a constraint error.
          const owned = await tx.query(
            `SELECT id FROM products WHERE id = $1 AND tenant_id = $2 AND brand_id = $3 AND user_id = $4`,
            [input.productId, tenant.id, input.brandId, user.id],
          );
          if (owned.rows.length === 0) return { ok: false, code: 'product_not_found' } as const;
        }
        const pin = await pinConversationInTx(tx, tenant, user, input, input.brandId, input.productId ?? null);
        return { ok: true, pin } as const;
      });
    },

    async get(brandId) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ id: UUID; name: string | null; attributes: Record<string, unknown>; created_at: Date }>(
          `SELECT id, name, attributes, created_at FROM brands
            WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'active'`,
          [brandId, tenant.id, user.id],
        );
        const row = res.rows[0];
        return row ? { id: row.id, name: row.name, attributes: row.attributes, createdAt: row.created_at.toISOString() } : null;
      });
    },

    async update(brandId, patch) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const result = await updateAttributesInTx(tx, { level: 'brand', id: brandId, tenantId: tenant.id, userId: user.id, patch });
        if (result.ok) return { ok: true, name: result.name } as const;
        return result.code === 'not_found' ? { ok: false, code: 'brand_not_found' } as const : result;
      });
    },

    async listActive() {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ id: UUID; name: string | null; attributes: Record<string, unknown>; created_at: Date; agent_states: unknown }>(
          `SELECT b.id, b.name, b.attributes, b.created_at, latest.agent_states
             FROM brands b
             LEFT JOIN LATERAL (
               SELECT c.agent_states FROM conversations c
                WHERE c.tenant_id = b.tenant_id AND c.brand_id = b.id
                ORDER BY c.started_at DESC, c.id DESC LIMIT 1
             ) latest ON true
            WHERE b.tenant_id = $1 AND b.user_id = $2 AND b.status = 'active'
            ORDER BY b.created_at, b.id`,
          [tenant.id, user.id],
        );
        return res.rows.map((row) => ({
          id: row.id,
          name: row.name?.trim() || businessNameFromAgentStates(row.agent_states),
          attributes: row.attributes,
          createdAt: row.created_at.toISOString(),
        }));
      });
    },

    async archive(brandId) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query(
          `UPDATE brands SET status = 'archived', archived_at = now(), updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'active'`,
          [brandId, tenant.id, user.id],
        );
        return (res.rowCount ?? 0) > 0;
      });
    },
  };
}
