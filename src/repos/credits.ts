/**
 * Tenant-side read of the credit ledger (D36, F21): balance, recharged total and consumption by
 * usage kind (`llm` / `image`). Read-only, tenant axis (RLS), no ledger rows exposed.
 */
import { USAGE_POLICY } from '../services/usage/policy';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';

export interface TenantCreditSummary {
  readonly balanceUsd: number;
  /** Recharges plus adjustments, USD. */
  readonly grantedUsd: number;
  /** Positive numbers, USD, by kind of provider call. */
  readonly consumptionByKind: { readonly llm: number; readonly image: number };
  /** Consumption (positive USD) in the current and previous calendar month, in the policy time zone. */
  readonly consumptionByMonth: { readonly current: number; readonly previous: number };
}

/** Whole-month offset of an entry from the current month (0 = this month, -1 = previous), in the policy zone ($2). */
const MONTH = `((extract(year from e.created_at AT TIME ZONE $2::text) * 12 + extract(month from e.created_at AT TIME ZONE $2::text))
  - (extract(year from now() AT TIME ZONE $2::text) * 12 + extract(month from now() AT TIME ZONE $2::text)))`;

export interface CreditsRepo {
  summary(): Promise<TenantCreditSummary>;
}

export function creditsRepo(tenant: Tenant, user: User): CreditsRepo {
  return {
    async summary() {
      return withTenantTransaction(tenant, user, async (tx) => {
        const result = await tx.query<{ balance: string; granted: string; llm: string; image: string; cur: string; prev: string }>(
          `SELECT coalesce(sum(e.amount_usd), 0)::text AS balance,
                  coalesce(sum(e.amount_usd) FILTER (WHERE e.kind IN ('recharge', 'adjustment')), 0)::text AS granted,
                  coalesce(-sum(e.amount_usd) FILTER (WHERE e.kind = 'consumption' AND r.kind = 'llm'), 0)::text AS llm,
                  coalesce(-sum(e.amount_usd) FILTER (WHERE e.kind = 'consumption' AND r.kind = 'image'), 0)::text AS image,
                  coalesce(-sum(e.amount_usd) FILTER (WHERE e.kind = 'consumption' AND ${MONTH} >= 0), 0)::text AS cur,
                  coalesce(-sum(e.amount_usd) FILTER (WHERE e.kind = 'consumption' AND ${MONTH} = -1), 0)::text AS prev
             FROM tenant_credit_entries e
             LEFT JOIN usage_reservations r ON r.tenant_id = e.tenant_id AND r.id = e.usage_reservation_id
            WHERE e.tenant_id = $1`,
          [tenant.id, USAGE_POLICY.timeZone],
        );
        const row = result.rows[0];
        return {
          balanceUsd: Number(row.balance),
          grantedUsd: Number(row.granted),
          consumptionByKind: { llm: Number(row.llm), image: Number(row.image) },
          consumptionByMonth: { current: Number(row.cur), previous: Number(row.prev) },
        };
      });
    },
  };
}
