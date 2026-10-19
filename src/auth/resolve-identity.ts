/**
 * Resolves a WorkOS-authenticated request to an existing tenant membership.
 * Organization-to-tenant configuration is only a routing hint; the repository
 * confirms the persisted tenant and active local user under ordinary tenant RLS.
 */
import { getWorkOS, withAuth } from '@workos-inc/authkit-nextjs';
import type { Tenant, User } from '../db/with-transaction';
import { systemRepos } from '../repos';
import { loggerFor } from '../services/logger';

const log = loggerFor('auth.resolve-identity');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKOS_ORG_ID_PATTERN = /^org_[A-Za-z0-9]+$/;
const WORKOS_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;

export type TenantRole = 'admin' | 'member';

export interface ResolvedIdentity {
  readonly tenant: Tenant;
  readonly user: User;
  readonly tenantRole: TenantRole;
  readonly workosUserId: string;
  readonly organizationId: string;
  readonly platformAdmin: boolean;
}

function organizationTenantMap(raw: string | undefined): Record<string, string> {
  if (!raw) throw new Error('La organización de tu cuenta no está habilitada.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('La configuración de acceso a organizaciones no es válida.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('La configuración de acceso a organizaciones no es válida.');
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.some(([organizationId, tenantId]) =>
    !WORKOS_ORG_ID_PATTERN.test(organizationId) ||
    typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId),
  )) {
    throw new Error('La configuración de acceso a organizaciones no es válida.');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function platformAdminIds(raw: string | undefined): ReadonlySet<string> {
  const ids = (raw ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.some((id) => !WORKOS_USER_ID_PATTERN.test(id))) {
    throw new Error('La configuración de acceso de plataforma no es válida.');
  }
  return new Set(ids);
}

async function hasActiveWorkOSMembership(
  organizationId: string,
  workosUserId: string,
): Promise<boolean> {
  const memberships = await getWorkOS().userManagement.listOrganizationMemberships({
    organizationId,
    userId: workosUserId,
    statuses: ['active'],
    limit: 100,
  });
  return memberships.data.some((membership) =>
      membership.organizationId === organizationId &&
      membership.userId === workosUserId &&
      membership.status === 'active',
  );
}

/** Revalidate a captured authenticated subject for long-lived streams. */
export async function verifyActiveMembership(input: {
  organizationId: string;
  workosUserId: string;
  tenantId: string;
  userId: string;
}): Promise<boolean> {
  if (!WORKOS_ORG_ID_PATTERN.test(input.organizationId) ||
      !WORKOS_USER_ID_PATTERN.test(input.workosUserId) ||
      !UUID_PATTERN.test(input.tenantId) || !UUID_PATTERN.test(input.userId)) {
    return false;
  }
  try {
    if (!await hasActiveWorkOSMembership(input.organizationId, input.workosUserId)) return false;
    const membership = await systemRepos({ id: input.tenantId }).identity?.resolveMember(
      input.organizationId,
      input.workosUserId,
    );
    return membership?.userId === input.userId;
  } catch {
    log.error(
      { organizationId: input.organizationId, workosUserId: input.workosUserId },
      'identity.membership_recheck_failed',
    );
    return false;
  }
}

export async function resolveIdentity(): Promise<ResolvedIdentity> {
  const { user: workosUser, organizationId } = await withAuth({ ensureSignedIn: true });
  if (!organizationId || !WORKOS_ORG_ID_PATTERN.test(organizationId)) {
    throw new Error('Tu sesión no tiene una organización activa.');
  }

  const tenantMap = organizationTenantMap(process.env.WORKOS_ORGANIZATION_TENANTS);
  if (!Object.hasOwn(tenantMap, organizationId)) {
    throw new Error('La organización de tu cuenta no está habilitada.');
  }
  const tenantId = tenantMap[organizationId];
  const configuredPlatformAdmins = platformAdminIds(process.env.PLATFORM_ADMIN_WORKOS_USER_IDS);

  let activeMembership: boolean;
  try {
    activeMembership = await hasActiveWorkOSMembership(organizationId, workosUser.id);
  } catch {
    log.error({ organizationId, workosUserId: workosUser.id }, 'identity.resolve.workos_membership_failed');
    throw new Error('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.');
  }
  if (!activeMembership) {
    throw new Error('Tu cuenta no tiene acceso activo a esta organización.');
  }

  const identityRepo = systemRepos({ id: tenantId }).identity;
  if (!identityRepo) {
    throw new Error('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.');
  }
  const membership = await identityRepo.resolveMember(
    organizationId,
    workosUser.id,
  );
  if (!membership) {
    throw new Error('Tu cuenta no tiene acceso activo a esta organización.');
  }

  return {
    tenant: { id: tenantId },
    user: { id: membership.userId },
    tenantRole: membership.role,
    workosUserId: workosUser.id,
    organizationId,
    platformAdmin: configuredPlatformAdmins.has(workosUser.id),
  };
}

/** Resolve identity and require tenant-level configuration authority. */
export async function requireTenantAdmin(): Promise<ResolvedIdentity> {
  const identity = await resolveIdentity();
  if (identity.tenantRole !== 'admin') {
    throw new Error('No tienes permiso para administrar la configuración de esta organización.');
  }
  return identity;
}

/** Resolve identity and require the separate platform-operator allowlist. */
export async function requirePlatformAdmin(): Promise<ResolvedIdentity> {
  const identity = await resolveIdentity();
  if (!identity.platformAdmin) {
    throw new Error('No tienes permiso para administrar la configuración de la plataforma.');
  }
  return identity;
}
