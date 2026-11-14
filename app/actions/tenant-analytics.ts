'use server';

/**
 * D41 / F23 controller for `/admin/analytics`. Re-resolves the live identity and requires an effective
 * tenant admin (also re-checked in the database). Returns aggregates and per-user counters only.
 */
import { unstable_rethrow } from 'next/navigation';
import { requireTenantAdmin, TenantAdminRequiredError } from '../../src/auth/resolve-identity';
import { BRIEF_CATALOG } from '../../src/core/brief';
import { repos } from '../../src/repos';
import { NotTenantAdminError } from '../../src/repos/tenant-accounts';
import type { TenantAnalytics } from '../../src/repos/tenant-analytics';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('actions.tenant-analytics');

export type TenantAnalyticsView =
  | { readonly ok: true; readonly analytics: TenantAnalytics }
  | { readonly ok: false; readonly error: string };

export async function getTenantAnalytics(): Promise<TenantAnalyticsView> {
  let identity;
  try {
    identity = await requireTenantAdmin();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TenantAdminRequiredError) {
      log.warn({ tenantId: error.identity.tenant.id, userId: error.identity.user.id }, 'tenant_analytics.refused_not_admin');
      return { ok: false, error: 'No tienes permiso para ver las estadísticas de esta organización.' };
    }
    return { ok: false, error: 'No pudimos cargar las estadísticas. Vuelve a intentarlo.' };
  }
  try {
    const analytics = await repos(identity.tenant, identity.user).tenantAnalytics.get(BRIEF_CATALOG);
    log.debug({ tenantId: identity.tenant.id, conversations: analytics.conversations }, 'tenant_analytics.loaded');
    return { ok: true, analytics };
  } catch (error) {
    if (error instanceof NotTenantAdminError) {
      log.warn({ tenantId: identity.tenant.id, userId: identity.user.id }, 'tenant_analytics.refused_not_admin_db');
      return { ok: false, error: 'No tienes permiso para ver las estadísticas de esta organización.' };
    }
    log.error({ tenantId: identity.tenant.id, err: error instanceof Error ? error.name : 'unknown' }, 'tenant_analytics.failed');
    return { ok: false, error: 'No pudimos cargar las estadísticas. Vuelve a intentarlo.' };
  }
}
