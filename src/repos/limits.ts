/**
 * D38 / D39 limits repository: the resolver (`effective limits` through the user's profile or the
 * tenant default), the counters (read from the existing tables, no event tables) and the tenant-admin
 * edit of the default profile. Decisions live in `src/core/limits/rules.ts`; this file only reads/writes.
 *
 *  - Alterations: iteration rows of `agent_tasks` that COMPLETED after an earlier completed task in the
 *    same iteration chain (a failed generation never counts; a retry of a failed first generation is
 *    still the first result), grouped by agent at the card's level (brand or product).
 *  - Turns: user messages that triggered the model (`ai_turn_id` set) in the conversation.
 *  - Writes go only through `app.set_limit_profile_value` (admin and range re-checked in the DB).
 */
import type { UUID } from '../core/contracts';
import type { LimitScope, LimitValues } from '../core/limits/catalog';
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { NotTenantAdminError } from './tenant-accounts';

const log = loggerFor('repos.limits');

export interface AlterationUsage {
  /** Completed alterations in the scope. */
  readonly used: number;
  /** True when the deliverable already has at least one completed result in the scope. */
  readonly hasResult: boolean;
}

export interface LimitAuditRow {
  readonly id: UUID;
  readonly actorEmail: string | null;
  readonly limitKey: string;
  readonly beforeValue: number | null;
  readonly afterValue: number;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface DefaultProfileView {
  readonly profileId: UUID;
  readonly name: string;
  /** Stored values (profile over platform defaults); the catalog completes the rest. */
  readonly values: LimitValues;
  readonly audit: ReadonlyArray<LimitAuditRow>;
}

export interface LimitsRepo {
  /** Stored limit values of the caller's profile (own profile, else tenant default) over platform defaults. */
  effectiveLimits(): Promise<LimitValues>;
  alterationUsage(input: { conversationId: UUID; agentId: string; scope: LimitScope }): Promise<AlterationUsage>;
  turnsUsed(conversationId: UUID): Promise<number>;
  /** Tenant admin only: throws `NotTenantAdminError` otherwise. */
  getDefaultProfile(auditLimit?: number): Promise<DefaultProfileView | null>;
  /** Tenant admin only; the DB re-checks role, range and tenant, and writes the audit row. */
  setValue(input: { profileId: UUID; limitKey: string; value: number; reason: string | null }): Promise<void>;
}

const keyedValues = (rows: ReadonlyArray<{ limit_key: string; value: number }>): LimitValues =>
  Object.fromEntries(rows.map((row) => [row.limit_key, row.value]));

/** Platform defaults overlaid by one profile's values (full outer join: keys only the profile has survive). */
const OVERLAY_SQL = (profile: string) => `
  SELECT coalesce(v.limit_key, d.limit_key) AS limit_key, coalesce(v.value, d.value)::int AS value
    FROM platform_limit_defaults d
    FULL OUTER JOIN (SELECT limit_key, value FROM limit_profile_values WHERE tenant_id = $1 AND profile_id = ${profile}) v
      ON v.limit_key = d.limit_key`;

/** Exported so brand/product creation can decide inside their own locked transaction. */
export async function readEffectiveLimits(tx: TxClient, tenant: Tenant, user: User): Promise<LimitValues> {
  const res = await tx.query<{ limit_key: string; value: number }>(
    OVERLAY_SQL(`coalesce(
      (SELECT limit_profile_id FROM users WHERE tenant_id = $1 AND id = $2),
      (SELECT id FROM limit_profiles WHERE tenant_id = $1 AND is_default))`),
    [tenant.id, user.id],
  );
  return keyedValues(res.rows);
}

export function limitsRepo(tenant: Tenant, user: User): LimitsRepo {
  async function assertAdmin(tx: TxClient): Promise<void> {
    const res = await tx.query<{ ok: boolean }>('SELECT app.has_tenant_admin() AS ok');
    if (!res.rows[0]?.ok) throw new NotTenantAdminError();
  }

  return {
    effectiveLimits: () => withTenantTransaction(tenant, user, (tx) => readEffectiveLimits(tx, tenant, user)),

    async alterationUsage({ conversationId, agentId, scope }) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const current = await tx.query<{ brand_id: UUID | null; product_id: UUID | null }>(
          `SELECT brand_id, product_id FROM conversations WHERE tenant_id = $1 AND id = $2`,
          [tenant.id, conversationId],
        );
        const row = current.rows[0];
        if (!row) return { used: 0, hasResult: false };
        // Column name comes from a closed set, never from input. A legacy conversation without the
        // brand/product counts only itself.
        const column = scope === 'brand' ? 'brand_id' : 'product_id';
        const scopeId = scope === 'brand' ? row.brand_id : scope === 'product' ? row.product_id : null;
        const scopeSql = scopeId ? `c.${column} = $4` : `c.id = $4`;
        const res = await tx.query<{ completed: number; altered: number }>(
          `SELECT count(*) FILTER (WHERE t.status = 'completed')::int AS completed,
                  count(*) FILTER (WHERE t.status = 'completed' AND t.parent_task_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM agent_tasks p
                     WHERE p.tenant_id = t.tenant_id AND p.iteration_root_id = t.iteration_root_id
                       AND p.status = 'completed' AND p.iteration_number < t.iteration_number))::int AS altered
             FROM agent_tasks t
             JOIN conversations c ON c.tenant_id = t.tenant_id AND c.id = t.conversation_id
            WHERE t.tenant_id = $1 AND t.agent_id = $2 AND c.user_id = $3 AND ${scopeSql}`,
          [tenant.id, agentId, user.id, scopeId ?? conversationId],
        );
        const counts = res.rows[0];
        log.debug({ tenantId: tenant.id, conversationId, agentId, scope, ...counts }, 'limits.alterationUsage');
        return { used: counts?.altered ?? 0, hasResult: (counts?.completed ?? 0) > 0 };
      });
    },

    async turnsUsed(conversationId) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM messages
            WHERE tenant_id = $1 AND conversation_id = $2 AND role = 'user' AND ai_turn_id IS NOT NULL`,
          [tenant.id, conversationId],
        );
        return res.rows[0]?.n ?? 0;
      });
    },

    async getDefaultProfile(auditLimit = 50) {
      return withTenantTransaction(tenant, user, async (tx) => {
        await assertAdmin(tx);
        const profile = await tx.query<{ id: UUID; name: string }>(
          `SELECT id, name FROM limit_profiles WHERE tenant_id = $1 AND is_default`, [tenant.id],
        );
        const row = profile.rows[0];
        if (!row) return null;
        const values = await tx.query<{ limit_key: string; value: number }>(OVERLAY_SQL('$2'), [tenant.id, row.id]);
        const audit = await tx.query<{
          id: UUID; email: string | null; limit_key: string; before_value: number | null; after_value: number;
          reason: string | null; created_at: Date;
        }>(
          `SELECT a.id, u.email, a.limit_key, a.before_value, a.after_value, a.reason, a.created_at
             FROM limit_profile_audit_events a
             LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.actor_user_id
            WHERE a.tenant_id = $1 AND a.profile_id = $2
            ORDER BY a.created_at DESC, a.id DESC LIMIT $3`,
          [tenant.id, row.id, Math.min(Math.max(auditLimit, 1), 200)],
        );
        return {
          profileId: row.id,
          name: row.name,
          values: keyedValues(values.rows),
          audit: audit.rows.map((a) => ({
            id: a.id, actorEmail: a.email, limitKey: a.limit_key, beforeValue: a.before_value,
            afterValue: a.after_value, reason: a.reason, createdAt: a.created_at.toISOString(),
          })),
        };
      });
    },

    async setValue({ profileId, limitKey, value, reason }) {
      await withTenantTransaction(tenant, user, async (tx) => {
        await assertAdmin(tx);
        await tx.query(`SELECT app.set_limit_profile_value($1, $2, $3, $4)`, [profileId, limitKey, value, reason]);
      });
      log.info({ tenantId: tenant.id, userId: user.id, profileId, limitKey, value }, 'limits.value_set');
    },
  };
}
