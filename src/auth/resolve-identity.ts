/** WorkOS identity resolution and server-side authorization boundaries. */
import { getWorkOS, withAuth } from '@workos-inc/authkit-nextjs';
import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Tenant, User } from '../db/with-transaction';
import { systemRepos } from '../repos';
import { globalRepos } from '../repos/global';
import { loggerFor } from '../services/logger';

const log = loggerFor('auth.resolve-identity');
const WORKOS_ORG_ID_PATTERN = /^org_[A-Za-z0-9]+$/;
const WORKOS_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;
const MFA_COOKIE = 'cremype_platform_mfa';
const MFA_TTL_SECONDS = 10 * 60;

export type TenantRole = 'admin' | 'member';
export interface ResolvedIdentity {
  readonly tenant: Tenant;
  readonly user: User;
  readonly tenantRole: TenantRole;
  readonly workosUserId: string;
  readonly organizationId: string;
  readonly platformAdmin: boolean;
}
export interface GlobalIdentity {
  readonly workosUserId: string;
  readonly sessionId: string;
}

async function hasActiveWorkOSMembership(organizationId: string, workosUserId: string): Promise<boolean> {
  const memberships = await getWorkOS().userManagement.listOrganizationMemberships({ organizationId, userId: workosUserId, statuses: ['active'], limit: 100 });
  return memberships.data.some((item) => item.organizationId === organizationId && item.userId === workosUserId && item.status === 'active');
}

/** Global console identity is independent of organization membership and tenant role. */
export async function requireGlobalAdmin(): Promise<GlobalIdentity> {
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
  const identity = await requireGlobalAdmin();
  const token = (await cookies()).get(MFA_COOKIE)?.value;
  if (!token || !validMfaProof(token, identity)) throw new Error('Verifica tu código de autenticación para continuar.');
  return identity;
}

export function mfaProofCookieName(): string { return MFA_COOKIE; }
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

export async function resolveIdentity(): Promise<ResolvedIdentity> {
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

export async function requireTenantAdmin(): Promise<ResolvedIdentity> {
  const identity = await resolveIdentity();
  if (identity.tenantRole !== 'admin') throw new Error('No tienes permiso para administrar la configuración de esta organización.');
  return identity;
}

/** Backward-compatible check for tenant-scoped AI settings; global mutations require MFA. */
export async function requirePlatformAdmin(): Promise<ResolvedIdentity> {
  const identity = await resolveIdentity();
  if (!identity.platformAdmin) throw new Error('No tienes permiso para administrar la configuración de la plataforma.');
  return identity;
}
