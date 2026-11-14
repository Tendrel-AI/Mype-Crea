'use server';

/** F21: read-only credit view for the tenant admin (the `/admin` page renders it). */
import { requireTenantAdmin } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import type { TenantCreditSummary } from '../../src/repos/credits';

export async function getTenantCreditSummary(): Promise<TenantCreditSummary> {
  const identity = await requireTenantAdmin();
  return repos(identity.tenant, identity.user).credits.summary();
}
