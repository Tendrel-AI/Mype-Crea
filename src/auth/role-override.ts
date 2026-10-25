/**
 * Developer role switcher (KAN-79): pure rules for acting with FEWER privileges.
 *
 * Only active behind `DEVELOPMENT=TRUE` (callers check `isDevelopmentMode()`).
 * The override is a set of reductions, not a set of roles: the cookie can only say
 * "drop tenant admin" and/or "drop platform admin", so no value of it can add a role.
 * The real roles resolved from WorkOS + the database stay the ceiling. It never
 * switches the user, the tenant, or the RLS bindings.
 */
export type TenantRole = 'admin' | 'member';

export interface RoleSet {
  readonly tenantRole: TenantRole;
  readonly platformAdmin: boolean;
}

/** What the developer asked to drop. Both false means "act with my real roles". */
export interface RoleReductions {
  readonly dropTenantAdmin: boolean;
  readonly dropPlatformAdmin: boolean;
}

/** Real roles as the switcher sees them; `tenantRole` is null without a tenant session. */
export interface RealRoles {
  readonly tenantRole: TenantRole | null;
  readonly platformAdmin: boolean;
}

/** Requested effective roles from the developer panel. */
export interface RequestedRoles {
  readonly tenantRole?: TenantRole;
  readonly platformAdmin?: boolean;
}

export type RoleOverridePlan =
  | { readonly ok: true; readonly reductions: RoleReductions }
  | { readonly ok: false; readonly reason: 'elevation' | 'invalid' };

const COOKIE_NAME = 'cremype_dev_role_override';
const COOKIE_TTL_SECONDS = 12 * 60 * 60;
const VERSION = 'v1';
const DROP_TENANT_ADMIN = 'tenant-member';
const DROP_PLATFORM_ADMIN = 'no-platform-admin';
const WORKOS_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;
// v1.<workos user id>.<reduction>[+<reduction>]: tokens in a fixed order, each at most once.
const COOKIE_PATTERN = /^v1\.(user_[A-Za-z0-9]+)\.(tenant-member|no-platform-admin|tenant-member\+no-platform-admin)$/;
const MAX_COOKIE_LENGTH = 128;

export const NO_REDUCTIONS: RoleReductions = Object.freeze({ dropTenantAdmin: false, dropPlatformAdmin: false });

export function roleOverrideCookieName(): string { return COOKIE_NAME; }

export function roleOverrideCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: COOKIE_TTL_SECONDS,
  };
}

export function hasReductions(reductions: RoleReductions): boolean {
  return reductions.dropTenantAdmin || reductions.dropPlatformAdmin;
}

/**
 * Parse the cookie strictly. Anything malformed, from another user, or with no
 * reduction is ignored entirely (returns undefined), never partially applied.
 */
export function parseRoleOverrideCookie(raw: string | undefined, workosUserId: string): RoleReductions | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_COOKIE_LENGTH) return undefined;
  const match = COOKIE_PATTERN.exec(raw);
  if (!match || match[1] !== workosUserId) return undefined;
  const tokens = match[2].split('+');
  return {
    dropTenantAdmin: tokens.includes(DROP_TENANT_ADMIN),
    dropPlatformAdmin: tokens.includes(DROP_PLATFORM_ADMIN),
  };
}

export function serializeRoleOverride(workosUserId: string, reductions: RoleReductions): string {
  if (!WORKOS_USER_ID_PATTERN.test(workosUserId)) throw new Error('Invalid WorkOS user id.');
  if (!hasReductions(reductions)) throw new Error('A role override needs at least one reduction.');
  const tokens = [
    ...(reductions.dropTenantAdmin ? [DROP_TENANT_ADMIN] : []),
    ...(reductions.dropPlatformAdmin ? [DROP_PLATFORM_ADMIN] : []),
  ];
  return `${VERSION}.${workosUserId}.${tokens.join('+')}`;
}

/** Effective roles = real roles minus reductions. Mathematically cannot add a role. */
export function applyRoleReductions(real: RoleSet, reductions: RoleReductions): RoleSet {
  return {
    tenantRole: real.tenantRole === 'admin' && !reductions.dropTenantAdmin ? 'admin' : 'member',
    platformAdmin: real.platformAdmin && !reductions.dropPlatformAdmin,
  };
}

/**
 * Turn a panel request into reductions, rejecting any request for a role the user
 * does not really hold. A tenant role request without a tenant session is invalid.
 */
export function planRoleOverride(real: RealRoles, requested: RequestedRoles): RoleOverridePlan {
  if (requested.tenantRole !== undefined && requested.tenantRole !== 'admin' && requested.tenantRole !== 'member') return { ok: false, reason: 'invalid' };
  if (requested.platformAdmin !== undefined && typeof requested.platformAdmin !== 'boolean') return { ok: false, reason: 'invalid' };
  if (requested.tenantRole === 'admin' && real.tenantRole !== 'admin') return { ok: false, reason: 'elevation' };
  if (requested.platformAdmin === true && !real.platformAdmin) return { ok: false, reason: 'elevation' };
  if (requested.tenantRole !== undefined && real.tenantRole === null) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    reductions: {
      dropTenantAdmin: real.tenantRole === 'admin' && requested.tenantRole === 'member',
      dropPlatformAdmin: real.platformAdmin && requested.platformAdmin === false,
    },
  };
}
