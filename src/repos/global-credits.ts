/**
 * Platform-side credit repository (D36, component 29): recharges/adjustments, the per-tenant
 * ledger and balance, the provisioned sub-key rows and the OpenRouter-only consumption by month.
 * Runs in global transactions; writes by a human go through `assertActivePlatformActor` and leave a
 * `platform_audit_events` row in the same transaction. Never exposes tenant content.
 */
import { withGlobalTransaction, type GlobalTxClient } from '../db/global-transaction';
import { assertActivePlatformActor, insertGlobalAuditEvent } from './global-audit';

export type CreditEntryKind = 'recharge' | 'consumption' | 'adjustment';

export interface CreditEntry {
  readonly id: string;
  readonly kind: CreditEntryKind;
  readonly amountUsd: number;
  readonly source: 'manual' | 'gateway' | 'settlement';
  readonly externalRef: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface StoredProviderKey {
  readonly tenantId: string;
  readonly keyCiphertext: string;
  readonly keyHash: string;
  readonly limitUsd: number;
  readonly status: 'active' | 'disabled';
}

export interface MonthlyLedgerConsumption { readonly month: string; readonly usd: number }

export interface ManualEntryInput {
  readonly tenantId: string;
  readonly kind: 'recharge' | 'adjustment';
  /** Positive for a recharge; signed (non-zero) for an adjustment. */
  readonly amountUsd: number;
  readonly idempotencyKey: string;
  readonly externalRef?: string;
  readonly reason: string;
  readonly actorWorkosUserId: string;
}

export async function readBalance(tx: GlobalTxClient, tenantId: string): Promise<number> {
  const result = await tx.query<{ balance: string }>(
    `SELECT coalesce(sum(amount_usd), 0)::text AS balance FROM tenant_credit_entries WHERE tenant_id = $1`, [tenantId],
  );
  return Number(result.rows[0].balance);
}

export function globalCreditsRepo() {
  return {
    balance: (tenantId: string) => withGlobalTransaction((tx) => readBalance(tx, tenantId)),

    /** Appends a recharge/adjustment + audit row. Replaying the same key with the same input is a no-op. */
    async recordEntry(input: ManualEntryInput): Promise<{ created: boolean; balanceUsd: number }> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        const inserted = await tx.query(
          `INSERT INTO tenant_credit_entries
             (tenant_id, kind, amount_usd, source, idempotency_key, external_ref, reason, actor_workos_user_id)
           VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
          [input.tenantId, input.kind, input.amountUsd, input.idempotencyKey, input.externalRef ?? null, input.reason, input.actorWorkosUserId],
        );
        const created = (inserted.rowCount ?? 0) === 1;
        if (created) {
          await insertGlobalAuditEvent(tx, {
            actorWorkosUserId: input.actorWorkosUserId, action: `credits.${input.kind}`,
            scopeType: 'organization', scopeId: input.tenantId, outcome: 'success', reason: input.reason,
            metadata: { amountUsd: input.amountUsd, externalRef: input.externalRef ?? null },
          });
        } else {
          const prior = await tx.query<{ amount_usd: string; kind: string }>(
            `SELECT amount_usd::text, kind FROM tenant_credit_entries WHERE tenant_id = $1 AND idempotency_key = $2`,
            [input.tenantId, input.idempotencyKey],
          );
          if (Number(prior.rows[0]?.amount_usd) !== input.amountUsd || prior.rows[0]?.kind !== input.kind) {
            throw new Error('Credit operation key was already used with different input.');
          }
        }
        return { created, balanceUsd: await readBalance(tx, input.tenantId) };
      });
    },

    async listLedger(actorWorkosUserId: string, tenantId: string, limit = 50): Promise<CreditEntry[]> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query<{
          id: string; kind: CreditEntryKind; amount_usd: string; source: CreditEntry['source'];
          external_ref: string | null; reason: string | null; created_at: Date;
        }>(
          `SELECT id, kind, amount_usd::text, source, external_ref, reason, created_at
             FROM tenant_credit_entries WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2`,
          [tenantId, Math.min(Math.max(limit, 1), 200)],
        );
        return result.rows.map((r) => ({
          id: r.id, kind: r.kind, amountUsd: Number(r.amount_usd), source: r.source,
          externalRef: r.external_ref, reason: r.reason, createdAt: r.created_at.toISOString(),
        }));
      });
    },

    /** Ledger consumption of OpenRouter calls by UTC month (OpenRouter's own month boundary), newest first. */
    async openRouterConsumptionByMonth(actorWorkosUserId: string, tenantId: string): Promise<MonthlyLedgerConsumption[]> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query<{ month: string; usd: string }>(
          `SELECT to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, (-sum(e.amount_usd))::text AS usd
             FROM tenant_credit_entries e
             JOIN usage_reservations r ON r.tenant_id = e.tenant_id AND r.id = e.usage_reservation_id
            WHERE e.tenant_id = $1 AND e.kind = 'consumption' AND r.provider = 'openrouter'
            GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
          [tenantId],
        );
        return result.rows.map((r) => ({ month: r.month, usd: Number(r.usd) }));
      });
    },

    async findKey(tenantId: string): Promise<StoredProviderKey | undefined> {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<{ key_ciphertext: string; key_hash: string; limit_usd: string; status: 'active' | 'disabled' }>(
          `SELECT key_ciphertext, key_hash, limit_usd::text, status FROM tenant_provider_keys
            WHERE tenant_id = $1 AND provider = 'openrouter'`, [tenantId],
        );
        const row = result.rows[0];
        return row
          ? { tenantId, keyCiphertext: row.key_ciphertext, keyHash: row.key_hash, limitUsd: Number(row.limit_usd), status: row.status }
          : undefined;
      });
    },

    async insertKey(actorWorkosUserId: string, key: StoredProviderKey): Promise<boolean> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query(
          `INSERT INTO tenant_provider_keys (tenant_id, provider, key_ciphertext, key_hash, limit_usd, status, limit_synced_at)
           VALUES ($1, 'openrouter', $2, $3, $4, $5, now()) ON CONFLICT (tenant_id, provider) DO NOTHING`,
          [key.tenantId, key.keyCiphertext, key.keyHash, key.limitUsd, key.status],
        );
        const created = (result.rowCount ?? 0) === 1;
        if (created) {
          await insertGlobalAuditEvent(tx, {
            actorWorkosUserId, action: 'credits.provider_key.create', scopeType: 'organization',
            scopeId: key.tenantId, outcome: 'success', metadata: { keyHash: key.keyHash },
          });
        }
        return created;
      });
    },

    async updateKey(tenantId: string, patch: { limitUsd?: number; status?: 'active' | 'disabled' }): Promise<void> {
      await withGlobalTransaction(async (tx) => {
        await tx.query(
          `UPDATE tenant_provider_keys
              SET limit_usd = coalesce($2::numeric, limit_usd), status = coalesce($3::text, status),
                  limit_synced_at = CASE WHEN $2::numeric IS NULL THEN limit_synced_at ELSE now() END, updated_at = now()
            WHERE tenant_id = $1 AND provider = 'openrouter'`,
          [tenantId, patch.limitUsd ?? null, patch.status ?? null],
        );
      });
    },
  };
}

export type GlobalCreditsRepo = ReturnType<typeof globalCreditsRepo>;
