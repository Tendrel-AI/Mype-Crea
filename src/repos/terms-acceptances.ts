/**
 * KAN-27 informed-consent repository. Rows are append-only evidence (`terms_acceptances`):
 * `accept` inserts once per (tenant, user, version) and returns the stored row; the server
 * clock sets `accepted_at` (app_user cannot insert it). Tenant + owner scoped by RLS and by the
 * explicit predicates below. All access goes through `withTenantTransaction(tenant, user)`.
 */
import type { UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import type { TermsAcceptanceRow } from './models';

export interface TermsAcceptancesRepo {
  /** True when the caller has accepted exactly `termsVersion`. */
  hasAccepted(termsVersion: string): Promise<boolean>;
  /** Record the caller's acceptance of `termsVersion`; idempotent per version. */
  accept(termsVersion: string): Promise<TermsAcceptanceRow>;
}

interface TermsAcceptanceRowDb {
  id: UUID;
  user_id: UUID;
  terms_version: string;
  accepted_at: Date;
}

const SELECT_OWN = `SELECT id, user_id, terms_version, accepted_at FROM terms_acceptances
  WHERE tenant_id = $1 AND user_id = $2 AND terms_version = $3`;

export function termsAcceptancesRepo(tenant: Tenant, user: User): TermsAcceptancesRepo {
  return {
    async hasAccepted(termsVersion) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query(SELECT_OWN, [tenant.id, user.id, termsVersion]);
        return res.rows.length > 0;
      });
    },

    async accept(termsVersion) {
      return withTenantTransaction(tenant, user, async (tx) => {
        await tx.query(
          `INSERT INTO terms_acceptances (tenant_id, user_id, terms_version) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, user_id, terms_version) DO NOTHING`,
          [tenant.id, user.id, termsVersion],
        );
        const res = await tx.query<TermsAcceptanceRowDb>(SELECT_OWN, [tenant.id, user.id, termsVersion]);
        const row = res.rows[0];
        if (!row) throw new Error('Terms acceptance was not recorded.');
        return {
          id: row.id,
          userId: row.user_id,
          termsVersion: row.terms_version,
          acceptedAt: row.accepted_at.toISOString(),
        };
      });
    },
  };
}
