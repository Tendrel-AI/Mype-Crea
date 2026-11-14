'use server';

/** D42 / F22 controller for `/admin/forecast`: tenant admin only (re-checked in the database). */
import { unstable_rethrow } from 'next/navigation';
import { requireTenantAdmin, TenantAdminRequiredError } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import type { ForecastView } from '../../src/repos/forecast';
import { NotTenantAdminError } from '../../src/repos/tenant-accounts';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('actions.forecast');

export type TenantForecastResult =
  | { readonly ok: true; readonly view: ForecastView }
  | { readonly ok: false; readonly error: string };

const REFUSED = 'No tienes permiso para ver la proyección de esta organización.';

export async function getTenantForecast(): Promise<TenantForecastResult> {
  let identity;
  try {
    identity = await requireTenantAdmin();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TenantAdminRequiredError) return { ok: false, error: REFUSED };
    return { ok: false, error: 'No pudimos cargar la proyección. Vuelve a intentarlo.' };
  }
  try {
    const view = await repos(identity.tenant, identity.user).forecast.latest();
    log.debug({ tenantId: identity.tenant.id, month: view.current.month }, 'forecast.loaded');
    return { ok: true, view };
  } catch (error) {
    if (error instanceof NotTenantAdminError) return { ok: false, error: REFUSED };
    log.error({ tenantId: identity.tenant.id, err: error instanceof Error ? error.name : 'unknown' }, 'forecast.failed');
    return { ok: false, error: 'No pudimos cargar la proyección. Vuelve a intentarlo.' };
  }
}
