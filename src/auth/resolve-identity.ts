/** WorkOS identity resolution and server-side authorization boundaries. */
import { getWorkOS, withAuth } from '@workos-inc/authkit-nextjs';
import { cookies } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Tenant, User } from '../db/with-transaction';
import { systemRepos } from '../repos';
import type { RepositoryActor } from '../repos/ai-config';
import { globalRepos } from '../repos/global';
import { isDevelopmentMode } from '../services/development-mode';
import { loggerFor } from '../services/logger';
import { MFA_PROOF_COOKIE, MfaRequiredError } from './platform-mfa';
import {
  applyRoleReductions,
  NO_REDUCTIONS,
  parseRoleOverrideCookie,
  roleOverrideCookieName,
  type RealRoles,
  type RoleReductions,
  type RoleSet,
  type TenantRole,
} from './role-override';

const log = loggerFor('auth.resolve-identity');
const WORKOS_ORG_ID_PATTERN = /^org_[A-Za-z0-9]+$/;
const WORKOS_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;
const MFA_TTL_SECONDS = 10 * 60;

export type { TenantRole } from './role-override';
export interface ResolvedIdentity {
  readonly tenant: Tenant;
  readonly user: User;
  /** Effective tenant role: the database role, minus any developer reduction (KAN-79). */
  readonly tenantRole: TenantRole;
  readonly workosUserId: string;
  readonly organizationId: string;
  /** Effective platform role: the persisted superadmin role, minus any developer reduction. */
  readonly platformAdmin: boolean;
  /**
   * Present only while a developer role override (DEVELOPMENT=TRUE) is reducing this identity.
   * Holds the real roles. Use it ONLY to add requirements (platform MFA step-up) or to describe
   * the reduction; never to grant access. Authorization reads `tenantRole` / `platformAdmin`.
   */
  readonly reducedFrom?: RoleSet;
}
/** What the developer role switcher panel needs to render (KAN-79). */
export interface RoleSwitcherState {
  readonly real: RealRoles;
  readonly effective: RealRoles;
  readonly reduced: boolean;
}
export interface GlobalIdentity {
  readonly workosUserId: string;
  readonly sessionId: string;
}

async function hasActiveWorkOSMembership(organizationId: string, workosUserId: string): Promise<boolean> {
  const memberships = await getWorkOS().userManagement.listOrganizationMemberships({ organizationId, userId: workosUserId, statuses: ['active'], limit: 100 });
  return memberships.data.some((item) => item.organizationId === organizationId && item.userId === workosUserId && item.status === 'active');
}

/**
 * Developer reductions for this user, read only when DEVELOPMENT=TRUE. With the flag off the
 * cookie is never read. A malformed cookie, or one bound to another user, is ignored.
 */
async function activeRoleReductions(workosUserId: string): Promise<RoleReductions | undefined> {
  if (!isDevelopmentMode()) return undefined;
  let raw: string | undefined;
  try { raw = (await cookies()).get(roleOverrideCookieName())?.value; } catch (error) {
    unstable_rethrow(error);
    return undefined;
  }
  return parseRoleOverrideCookie(raw, workosUserId);
}

/** Global console identity is independent of organization membership and tenant role. */
export async function requireGlobalAdmin(): Promise<GlobalIdentity> {
  const identity = await resolveRealGlobalAdmin();
  const reductions = await activeRoleReductions(identity.workosUserId);
  if (reductions?.dropPlatformAdmin) {
    log.info({ workosUserId: identity.workosUserId, real: { platformAdmin: true }, effective: { platformAdmin: false } }, 'auth.role_override.applied');
    throw new Error('No tienes permiso para administrar la plataforma.');
  }
  return identity;
}

/** Persisted superadmin check with no developer reduction applied. */
async function resolveRealGlobalAdmin(): Promise<GlobalIdentity> {
  const auth = await withAuth({ ensureSignedIn: true });
  if (!WORKOS_USER_ID_PATTERN.test(auth.user.id) || !auth.sessionId) throw new Error('No tienes permiso para administrar la plataforma.');
  const store = globalRepos().identity;
  const configuredId = process.env.PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID?.trim();
  if (configuredId && configuredId === auth.user.id) {
    try {
      await store.bootstrapSuperadmin(auth.user.id);
    } catch (error) {
      log.error({ workosUserId: auth.user.id, error }, 'auth.superadmin.bootstrap_failed');
      throw new Error('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.');
    }
  }
  let isSuperadmin = false;
  try { isSuperadmin = await store.isSuperadmin(auth.user.id); } catch (error) {
    log.error({ workosUserId: auth.user.id, error }, 'auth.superadmin.lookup_failed');
    throw new Error('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.');
  }
  if (!isSuperadmin) throw new Error('No tienes permiso para administrar la plataforma.');
  return { workosUserId: auth.user.id, sessionId: auth.sessionId };
}

/** Require a fresh proof cookie signed by this server and bound to current user/session. */
export async function requireGlobalMfa(): Promise<GlobalIdentity> {
  return requireMfaProof(await requireGlobalAdmin());
}

/**
 * Step-up for any session whose REAL role is platform admin. A developer reduction removes
 * platform authority but never the MFA requirement attached to the account (KAN-79).
 */
export async function requirePlatformStepUp(identity: ResolvedIdentity): Promise<void> {
  if (identity.platformAdmin) {
    await requireGlobalMfa();
    return;
  }
  if (identity.reducedFrom?.platformAdmin) await requireMfaProof(await resolveRealGlobalAdmin());
}

async function requireMfaProof(identity: GlobalIdentity): Promise<GlobalIdentity> {
  const token = (await cookies()).get(MFA_PROOF_COOKIE)?.value;
  if (!token || !validMfaProof(token, identity)) throw new MfaRequiredError();
  return identity;
}

export function mfaProofTtlSeconds(): number { return MFA_TTL_SECONDS; }
export function signMfaProof(identity: GlobalIdentity, issuedAt = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid: identity.workosUserId, sid: identity.sessionId, iat: issuedAt, kind: 'verified' })).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function signMfaPending(identity: GlobalIdentity, challengeId: string, factorId: string, issuedAt = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid: identity.workosUserId, sid: identity.sessionId, iat: issuedAt, kind: 'pending', challengeId, factorId })).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifyMfaPending(token: string, identity: GlobalIdentity): { challengeId: string; factorId: string } | undefined {
  const parsed = parseProof(token, identity);
  if (!parsed || parsed.kind !== 'pending' || typeof parsed.challengeId !== 'string' || typeof parsed.factorId !== 'string') return undefined;
  return { challengeId: parsed.challengeId, factorId: parsed.factorId };
}

function validMfaProof(token: string, identity: GlobalIdentity): boolean {
  return parseProof(token, identity)?.kind === 'verified';
}

function parseProof(token: string, identity: GlobalIdentity): Record<string, unknown> | undefined {
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra) return undefined;
  const expected = signature(payload);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return parsed.uid === identity.workosUserId && parsed.sid === identity.sessionId && typeof parsed.iat === 'number' &&
      parsed.iat <= Date.now() && Date.now() - parsed.iat <= MFA_TTL_SECONDS * 1000 ? parsed : undefined;
  } catch { return undefined; }
}

function signature(payload: string): string {
  const secret = process.env.WORKOS_COOKIE_PASSWORD;
  if (!secret || secret.length < 32) throw new Error('La configuración de sesión no está disponible.');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Revalidate membership, organization status, and local membership during a long-lived stream. */
export async function verifyActiveMembership(input: { organizationId: string; workosUserId: string; tenantId: string; userId: string }): Promise<boolean> {
  if (!WORKOS_ORG_ID_PATTERN.test(input.organizationId) || !WORKOS_USER_ID_PATTERN.test(input.workosUserId)) return false;
  try {
    if (!await globalRepos().organizations.isActive(input.organizationId)) return false;
    if (!await hasActiveWorkOSMembership(input.organizationId, input.workosUserId)) return false;
    const membership = await systemRepos({ id: input.tenantId }).identity?.resolveMember(input.organizationId, input.workosUserId);
    return membership?.userId === input.userId;
  } catch (error) {
    log.error({ organizationId: input.organizationId, workosUserId: input.workosUserId, error }, 'identity.membership_recheck_failed');
    return false;
  }
}

/**
 * Resolve the caller's tenant identity. Behind DEVELOPMENT=TRUE a developer may reduce their
 * roles (KAN-79); the reduction is applied HERE so every downstream check (app-level guards,
 * repository actors, and the platform-admin GUC selection) sees the effective role.
 */
export async function resolveIdentity(): Promise<ResolvedIdentity> {
  return withRoleReductions(await resolveRealIdentity());
}

async function withRoleReductions(real: ResolvedIdentity): Promise<ResolvedIdentity> {
  const reductions = await activeRoleReductions(real.workosUserId);
  if (!reductions) return real;
  const realRoles: RoleSet = { tenantRole: real.tenantRole, platformAdmin: real.platformAdmin };
  const effective = applyRoleReductions(realRoles, reductions);
  if (effective.tenantRole === realRoles.tenantRole && effective.platformAdmin === realRoles.platformAdmin) return real;
  log.info({ userId: real.user.id, workosUserId: real.workosUserId, tenantId: real.tenant.id, real: realRoles, effective }, 'auth.role_override.applied');
  return { ...real, tenantRole: effective.tenantRole, platformAdmin: effective.platformAdmin, reducedFrom: realRoles };
}

/**
 * Real roles with no reduction applied, for the developer switcher only (ceiling check and
 * panel). `tenantRole` is null when the session has no usable tenant membership.
 */
export async function resolveRealRoles(): Promise<{ readonly workosUserId: string; readonly userId: string | null; readonly roles: RealRoles }> {
  let tenant: ResolvedIdentity | undefined;
  try { tenant = await resolveRealIdentity(); } catch (error) {
    unstable_rethrow(error);
    tenant = undefined;
  }
  if (tenant) return { workosUserId: tenant.workosUserId, userId: tenant.user.id, roles: { tenantRole: tenant.tenantRole, platformAdmin: tenant.platformAdmin } };
  const { user } = await withAuth({ ensureSignedIn: true });
  let platformAdmin = false;
  try { await resolveRealGlobalAdmin(); platformAdmin = true; } catch (error) {
    unstable_rethrow(error);
    platformAdmin = false;
  }
  return { workosUserId: user.id, userId: null, roles: { tenantRole: null, platformAdmin } };
}

/** Panel state for the developer role switcher; null when the flag is off or nothing applies. */
export async function getRoleSwitcherState(): Promise<RoleSwitcherState | null> {
  if (!isDevelopmentMode()) return null;
  try {
    const { user } = await withAuth();
    if (!user) return null;
    const { workosUserId, roles: real } = await resolveRealRoles();
    if (real.tenantRole !== 'admin' && !real.platformAdmin) return null;
    const reductions = await activeRoleReductions(workosUserId) ?? NO_REDUCTIONS;
    const applied = applyRoleReductions({ tenantRole: real.tenantRole ?? 'member', platformAdmin: real.platformAdmin }, reductions);
    const effective: RealRoles = { tenantRole: real.tenantRole === null ? null : applied.tenantRole, platformAdmin: applied.platformAdmin };
    return { real, effective, reduced: effective.tenantRole !== real.tenantRole || effective.platformAdmin !== real.platformAdmin };
  } catch (error) {
    // Let Next.js control flow (dynamic rendering bailout, redirects) through untouched.
    unstable_rethrow(error);
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'auth.role_override.state_failed');
    return null;
  }
}

/** Repository actor built from the EFFECTIVE identity; selects the DB admin context. */
export function repositoryActor(identity: ResolvedIdentity): RepositoryActor {
  return { workosUserId: identity.workosUserId, platformAdmin: identity.platformAdmin, tenantRole: identity.tenantRole };
}

async function resolveRealIdentity(): Promise<ResolvedIdentity> {
  const { user: workosUser, organizationId } = await withAuth({ ensureSignedIn: true });
  if (!organizationId || !WORKOS_ORG_ID_PATTERN.test(organizationId)) throw new Error('Tu sesión no tiene una organización activa.');
  if (!WORKOS_USER_ID_PATTERN.test(workosUser.id)) throw new Error('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.');
  let organization;
  try { organization = await globalRepos().organizations.findByWorkosOrgId(organizationId); } catch (error) {
    log.error({ organizationId, error }, 'identity.organization_lookup_failed');
    throw new Error('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.');
  }
  if (!organization) throw new Error('La organización de tu cuenta no está habilitada.');
  if (organization.status !== 'active') throw new Error('El acceso a esta organización está pausado.');
  let activeMembership = false;
  try { activeMembership = await hasActiveWorkOSMembership(organizationId, workosUser.id); } catch (error) {
    log.error({ organizationId, workosUserId: workosUser.id, error }, 'identity.resolve.workos_membership_failed');
    throw new Error('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.');
  }
  if (!activeMembership) throw new Error('Tu cuenta no tiene acceso activo a esta organización.');
  const membership = await systemRepos({ id: organization.tenantId }).identity?.resolveMember(organizationId, workosUser.id);
  if (!membership) throw new Error('Tu cuenta no tiene acceso activo a esta organización.');
  let platformAdmin = false;
  try { platformAdmin = await globalRepos().identity.isSuperadmin(workosUser.id); } catch (error) {
    log.error({ workosUserId: workosUser.id, error }, 'identity.superadmin_lookup_failed');
    throw new Error('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.');
  }
  return { tenant: { id: organization.tenantId }, user: { id: membership.userId }, tenantRole: membership.role, workosUserId: workosUser.id, organizationId, platformAdmin };
}

/** A resolved member who is not an effective tenant admin. Carries the identity for refusal logs. */
export class TenantAdminRequiredError extends Error {
  constructor(readonly identity: ResolvedIdentity) {
    super('No tienes permiso para administrar la configuración de esta organización.');
    this.name = 'TenantAdminRequiredError';
  }
}

/**
 * Reusable tenant-admin guard (AI settings, account management KAN-41, trace reads): the
 * EFFECTIVE tenant role from the live identity. Repositories re-check the persisted role with
 * `app.has_tenant_admin()`.
 */
export async function requireTenantAdmin(): Promise<ResolvedIdentity> {
  const identity = await resolveIdentity();
  if (identity.tenantRole !== 'admin') throw new TenantAdminRequiredError(identity);
  return identity;
}

/** Backward-compatible check for tenant-scoped AI settings; global mutations require MFA. */
export async function requirePlatformAdmin(): Promise<ResolvedIdentity> {
  const identity = await resolveIdentity();
  if (!identity.platformAdmin) throw new Error('No tienes permiso para administrar la configuración de la plataforma.');
  return identity;
}
