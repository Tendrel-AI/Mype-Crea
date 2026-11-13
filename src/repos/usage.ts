/**
 * KAN-43 usage ledger (`usage_reservations`). Every gated provider call reserves here first.
 *
 * `reserve` takes a per-tenant transaction-scoped advisory lock, reads the committed counters,
 * asks the pure policy (`evaluateUsage`) and inserts either a `reserved` or a `denied` row, all
 * in ONE transaction. The next reserver of the tenant waits for that commit and then sees it, so
 * parallel calls cannot push spending or call counts past a cap. `preflight` runs the same check
 * without holding anything (it writes only the denied row); the reservation stays the guarantee.
 */
import type { UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';
import {
  PRICING_VERSION,
  USAGE_POLICY,
  evaluateUsage,
  type CostSource,
  type UsageAsk,
  type UsageCounters,
  type UsageDenialReason,
  type UsageKind,
} from '../services/usage/policy';

export interface UsageCorrelation {
  readonly provider?: string;
  readonly model?: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly agentTaskId?: string;
}

export type UsageRequest = UsageAsk & UsageCorrelation;

export type UsageVerdict =
  | { readonly allowed: true; readonly reservationId: UUID | null }
  | { readonly allowed: false; readonly reason: UsageDenialReason; readonly reservationId: UUID };

export interface UsageSettlement {
  readonly reservationId: string;
  readonly actualCostUsd: number;
  readonly costSource: CostSource;
  readonly outcome: 'succeeded' | 'failed';
}

export interface UsageRepo {
  /** Hold the estimate (allowed) or record the denial; one locked transaction. */
  reserve(request: UsageRequest): Promise<UsageVerdict>;
  /** Check without reserving; a denial is still recorded. `reservationId` is null when allowed. */
  preflight(request: UsageRequest): Promise<UsageVerdict>;
  /**
   * Reconcile a `reserved` row with the real cost and, in the same transaction, append the matching
   * `consumption` ledger entry (idempotent on the reservation). False when it is not the caller's reserved row.
   */
  settle(settlement: UsageSettlement): Promise<boolean>;
}

/** Credit and call counters of the tenant (and of `userId`, when given) under the current policy. */
export async function readUsageCounters(tx: TxClient, tenantId: string, userId: string | null): Promise<UsageCounters> {
  const result = await tx.query<{ balance: string; reserved: string; llm_hour: number; image_day: number }>(
    `WITH bounds AS (
       SELECT (date_trunc('day', now() AT TIME ZONE $3::text) AT TIME ZONE $3::text) AS day_start
     )
     SELECT (SELECT coalesce(sum(amount_usd), 0) FROM tenant_credit_entries WHERE tenant_id = $1)::text AS balance,
            (SELECT coalesce(sum(estimated_cost_usd), 0) FROM usage_reservations
              WHERE tenant_id = $1 AND status = 'reserved')::text AS reserved,
            count(*) FILTER (WHERE r.user_id = $2 AND r.kind = 'llm' AND r.status <> 'denied'
                               AND r.created_at > now() - interval '1 hour')::int AS llm_hour,
            count(*) FILTER (WHERE r.user_id = $2 AND r.kind = 'image' AND r.status <> 'denied'
                               AND r.created_at >= b.day_start)::int AS image_day
       FROM bounds b
       LEFT JOIN usage_reservations r
         ON r.tenant_id = $1 AND r.created_at >= least(b.day_start, now() - interval '1 hour')
      GROUP BY b.day_start`,
    [tenantId, userId, USAGE_POLICY.timeZone],
  );
  const row = result.rows[0];
  return {
    balanceUsd: Number(row.balance),
    reservedUsd: Number(row.reserved),
    userLlmCallsLastHour: row.llm_hour,
    userImagesToday: row.image_day,
  };
}

export function usageRepo(tenant: Tenant, user: User): UsageRepo {
  async function decide(request: UsageRequest, hold: boolean): Promise<UsageVerdict> {
    return withTenantTransaction(tenant, user, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('usage_reservations:' || $1::text, 0))`, [tenant.id]);
      const counters = await readUsageCounters(tx, tenant.id, user.id);
      const reason = evaluateUsage(counters, request);
      if (!reason && !hold) return { allowed: true, reservationId: null };
      const id = await insertRow(tx, request, reason);
      return reason ? { allowed: false, reason, reservationId: id } : { allowed: true, reservationId: id };
    });
  }

  async function insertRow(tx: TxClient, request: UsageRequest, reason: UsageDenialReason | null): Promise<UUID> {
    const result = await tx.query<{ id: UUID }>(
      `INSERT INTO usage_reservations
         (tenant_id, user_id, kind, status, denial_reason, estimated_cost_usd, pricing_version,
          provider, model, conversation_id, turn_id, attempt_id, agent_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        tenant.id,
        user.id,
        request.kind satisfies UsageKind,
        reason ? 'denied' : 'reserved',
        reason,
        request.estimatedCostUsd,
        PRICING_VERSION,
        request.provider ?? null,
        request.model ?? null,
        request.conversationId ?? null,
        request.turnId ?? null,
        request.attemptId ?? null,
        request.agentTaskId ?? null,
      ],
    );
    return result.rows[0].id;
  }

  return {
    reserve: (request) => decide(request, true),
    preflight: (request) => decide(request, false),
    async settle({ reservationId, actualCostUsd, costSource, outcome }) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const result = await tx.query<{ actual_cost_usd: string }>(
          `UPDATE usage_reservations
              SET status = 'settled', actual_cost_usd = $4, cost_source = $6, outcome = $5, settled_at = now()
            WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND status = 'reserved'
            RETURNING actual_cost_usd::text`,
          [tenant.id, user.id, reservationId, actualCostUsd, outcome, costSource],
        );
        if (result.rows.length !== 1) return false;
        // Stored (rounded) cost, so ledger and reservation agree to the cent-micro; zero cost writes nothing.
        const stored = Number(result.rows[0].actual_cost_usd);
        if (stored > 0) {
          await tx.query(
            `INSERT INTO tenant_credit_entries (tenant_id, kind, amount_usd, source, idempotency_key, usage_reservation_id)
             VALUES ($1, 'consumption', $2, 'settlement', $3, $4)
             ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
            [tenant.id, -stored, `settle:${reservationId}`, reservationId],
          );
        }
        return true;
      });
    },
  };
}
