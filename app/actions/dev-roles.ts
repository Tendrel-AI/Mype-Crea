'use server';

/**
 * Developer role switcher (KAN-79). Exists only behind DEVELOPMENT=TRUE: with the flag off
 * every request is rejected. Downgrade only: the real roles are the ceiling, a request for a
 * role the user does not really hold is rejected, and the cookie can only encode reductions.
 */
import { cookies } from 'next/headers';
import { resolveRealRoles } from '../../src/auth/resolve-identity';
import {
  applyRoleReductions,
  hasReductions,
  planRoleOverride,
  roleOverrideCookieName,
  roleOverrideCookieOptions,
  serializeRoleOverride,
  type RequestedRoles,
} from '../../src/auth/role-override';
import { isDevelopmentMode } from '../../src/services/development-mode';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('auth.dev-roles');

export interface DevRoleActionResult {
  readonly ok: boolean;
  readonly message?: string;
}

const UNAVAILABLE = 'Esta herramienta no está disponible.';
const INVALID = 'La selección de roles no es válida.';

function parseRequest(input: unknown): RequestedRoles | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'tenantRole' && key !== 'platformAdmin')) return undefined;
  const { tenantRole, platformAdmin } = record;
  if (tenantRole !== undefined && tenantRole !== 'admin' && tenantRole !== 'member') return undefined;
  if (platformAdmin !== undefined && typeof platformAdmin !== 'boolean') return undefined;
  return { tenantRole, platformAdmin };
}

/** Act with the requested (equal or lower) roles. Asking for your real roles clears the override. */
export async function setDevRoleOverrideAction(input: unknown): Promise<DevRoleActionResult> {
  if (!isDevelopmentMode()) {
    log.warn('auth.role_override.rejected_flag_off');
    return { ok: false, message: UNAVAILABLE };
  }
  const requested = parseRequest(input);
  if (!requested) return { ok: false, message: INVALID };
  try {
    const real = await resolveRealRoles();
    const plan = planRoleOverride(real.roles, requested);
    if (!plan.ok) {
      log.warn({ workosUserId: real.workosUserId, userId: real.userId, real: real.roles, requested, reason: plan.reason }, 'auth.role_override.rejected');
      return { ok: false, message: plan.reason === 'elevation' ? 'Solo puedes reducir tus roles, no aumentarlos.' : INVALID };
    }
    const jar = await cookies();
    if (!hasReductions(plan.reductions)) {
      jar.delete({ name: roleOverrideCookieName(), path: '/' });
      log.info({ workosUserId: real.workosUserId, userId: real.userId }, 'auth.role_override.reset');
      return { ok: true };
    }
    jar.set(roleOverrideCookieName(), serializeRoleOverride(real.workosUserId, plan.reductions), roleOverrideCookieOptions());
    const effective = applyRoleReductions({ tenantRole: real.roles.tenantRole ?? 'member', platformAdmin: real.roles.platformAdmin }, plan.reductions);
    log.info({
      workosUserId: real.workosUserId,
      userId: real.userId,
      real: real.roles,
      effective: { tenantRole: real.roles.tenantRole === null ? null : effective.tenantRole, platformAdmin: effective.platformAdmin },
    }, 'auth.role_override.set');
    return { ok: true };
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'auth.role_override.set_failed');
    return { ok: false, message: 'No pudimos cambiar tus roles. Inténtalo de nuevo.' };
  }
}

/** «Volver a mis roles»: drop every reduction. */
export async function resetDevRoleOverrideAction(): Promise<DevRoleActionResult> {
  if (!isDevelopmentMode()) {
    log.warn('auth.role_override.rejected_flag_off');
    return { ok: false, message: UNAVAILABLE };
  }
  try {
    (await cookies()).delete({ name: roleOverrideCookieName(), path: '/' });
    log.info('auth.role_override.reset');
    return { ok: true };
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'auth.role_override.reset_failed');
    return { ok: false, message: 'No pudimos restablecer tus roles. Inténtalo de nuevo.' };
  }
}
