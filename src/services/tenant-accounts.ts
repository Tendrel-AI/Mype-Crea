/**
 * KAN-41 / D52: a tenant admin provisions, deactivates and reactivates members of their own
 * organization. WorkOS is the source of truth for membership and role; provisioning is WorkOS-only
 * (no `users` insert: identity resolution mirrors the row on first sign-in, D2). WorkOS is reached
 * only through `WorkosAccountsClient`, so tests inject a fake. No invitation email is ever sent:
 * the admin shares the `/login` link and the person proves ownership of the email at sign-in.
 *
 * Deactivation order (D4), so access ends at once and the session ends too:
 *  1. local mirror `status = 'inactive'` when a row exists (workers and the usage gateway read it);
 *  2. WorkOS membership deactivated;
 *  3. the user's WorkOS sessions for this organization revoked.
 * A failure after step 1 is logged and audited but never undoes step 1; calling deactivate again
 * re-syncs. Reactivation does WorkOS first, then the local mirror.
 */
import { getWorkOS } from '@workos-inc/authkit-nextjs';
import type { Tenant, User } from '../db/with-transaction';
import type { AccountAction, AccountAuditEntry, AccountRole, AccountStatus, TenantAccountsRepo } from '../repos/tenant-accounts';
import { loggerFor } from './logger';

const log = loggerFor('tenant-accounts');

/** A WorkOS organization membership joined with the user's email. */
export interface WorkosMember {
  readonly workosUserId: string;
  readonly email: string;
  readonly role: AccountRole;
  readonly status: AccountStatus;
  readonly createdAt: string;
}

export type ActivateOutcome = 'created' | 'reactivated' | 'already_active' | 'upgraded';

export interface WorkosAccountsClient {
  /** The WorkOS user with this email, created when missing (no password). Never sends an invitation. */
  ensureUser(email: string): Promise<{ id: string }>;
  /** Active and inactive memberships of the organization, with the user's email. */
  listMemberships(organizationId: string): Promise<ReadonlyArray<WorkosMember>>;
  /**
   * Leave the user with an active membership (create or reactivate). With `roleSlug: 'admin'` an
   * existing non-admin membership is upgraded; `member` never demotes an existing admin.
   */
  activateMembership(organizationId: string, workosUserId: string, roleSlug: AccountRole): Promise<ActivateOutcome>;
  /** Deactivate the user's membership in the organization, if any. */
  deactivateMembership(organizationId: string, workosUserId: string): Promise<void>;
  /** End the user's WorkOS sessions for the organization (sessions with no organization are all ended). */
  revokeSessions(organizationId: string, workosUserId: string): Promise<void>;
}

export function createWorkosAccountsClient(): WorkosAccountsClient {
  const um = () => getWorkOS().userManagement;
  const roleOf = (slug?: string): AccountRole => (slug === 'admin' ? 'admin' : 'member');
  const memberships = async (organizationId: string, userId?: string) =>
    (await (await um().listOrganizationMemberships({ organizationId, ...(userId ? { userId } : {}), statuses: ['active', 'inactive'], limit: 100 })).autoPagination())
      .filter((item) => item.organizationId === organizationId && (!userId || item.userId === userId));
  return {
    async ensureUser(email) {
      const found = (await um().listUsers({ email, limit: 1 })).data[0];
      return { id: (found ?? await um().createUser({ email })).id };
    },
    async listMemberships(organizationId) {
      const items = await memberships(organizationId);
      // shortcut: one getUser per member, fine for pilot-size organizations; batch if tenants grow past ~100 members.
      return Promise.all(items.map(async (item): Promise<WorkosMember> => ({
        workosUserId: item.userId,
        email: (await um().getUser(item.userId)).email,
        role: roleOf(item.role?.slug),
        status: item.status === 'active' ? 'active' : 'inactive',
        createdAt: item.createdAt,
      })));
    },
    async activateMembership(organizationId, workosUserId, roleSlug) {
      const existing = await memberships(organizationId, workosUserId);
      const active = existing.find((item) => item.status === 'active');
      const inactive = existing.find((item) => item.status === 'inactive');
      let current = active;
      let outcome: ActivateOutcome = 'already_active';
      if (!active && inactive) { current = await um().reactivateOrganizationMembership(inactive.id); outcome = 'reactivated'; }
      else if (!active) { current = await um().createOrganizationMembership({ organizationId, userId: workosUserId, roleSlug }); outcome = 'created'; }
      if (roleSlug === 'admin' && current && roleOf(current.role?.slug) !== 'admin') {
        await um().updateOrganizationMembership(current.id, { roleSlug: 'admin' });
        return outcome === 'already_active' ? 'upgraded' : outcome;
      }
      return outcome;
    },
    async deactivateMembership(organizationId, workosUserId) {
      for (const item of await memberships(organizationId, workosUserId)) {
        if (item.status === 'active') await um().deactivateOrganizationMembership(item.id);
      }
    },
    async revokeSessions(organizationId, workosUserId) {
      const sessions = await (await um().listSessions(workosUserId, { limit: 100 })).autoPagination();
      for (const session of sessions) {
        if (session.status === 'active' && (!session.organizationId || session.organizationId === organizationId)) {
          await um().revokeSession({ sessionId: session.id });
        }
      }
    },
  };
}

/** The acting admin, always taken from the resolved session identity. */
export interface AccountActor {
  readonly tenant: Tenant;
  readonly user: User;
  readonly workosUserId: string;
  readonly organizationId: string;
}

export type AccountResultCode =
  | 'provisioned' | 'already_active' | 'deactivated' | 'reactivated' | 'already_inactive'
  | 'invalid_email' | 'invalid_reason' | 'not_found' | 'self_deactivation' | 'last_admin'
  | 'not_admin' | 'failed';

export interface AccountResult {
  readonly ok: boolean;
  readonly code: AccountResultCode;
  readonly message: string;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKOS_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;
const FAILED = 'No pudimos completar la acción. Vuelve a intentarlo.';

const result = (ok: boolean, code: AccountResultCode, message: string): AccountResult => ({ ok, code, message });

export class TenantAccountService {
  constructor(private readonly repo: TenantAccountsRepo, private readonly workos: WorkosAccountsClient) {}

  /** Members come from WorkOS, so a provisioned person who never signed in is listed too. */
  listMembers(actor: AccountActor): Promise<ReadonlyArray<WorkosMember>> {
    return this.workos.listMemberships(actor.organizationId);
  }

  async provision(actor: AccountActor, input: { email: unknown; reason?: unknown }): Promise<AccountResult> {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) return result(false, 'invalid_email', 'Escribe un correo electrónico válido.');
    const reason = parseReason(input.reason);
    if (reason === undefined) return result(false, 'invalid_reason', 'El motivo puede tener hasta 500 caracteres.');

    const failedAudit = (code: string): AccountAuditEntry => ({
      action: 'member.provision', targetUserId: null, targetEmail: email, beforeStatus: null,
      afterStatus: null, reason, outcome: 'failed', outcomeCode: code,
    });
    let workosUserId: string;
    let outcome: ActivateOutcome;
    try {
      workosUserId = (await this.workos.ensureUser(email)).id;
      outcome = await this.workos.activateMembership(actor.organizationId, workosUserId, 'member');
    } catch (error) {
      log.error({ tenantId: actor.tenant.id, actorUserId: actor.user.id, err: errorName(error) }, 'tenant_accounts.provision.workos_failed');
      await this.safeAudit(failedAudit('workos_failed'));
      return result(false, 'failed', FAILED);
    }
    if (outcome === 'already_active') return result(true, 'already_active', `${email} ya tiene una cuenta activa en tu organización.`);
    let targetUserId: string | null = null;
    try {
      // A previously deactivated person may still have a local inactive row; reactivation lifts that block.
      if (outcome === 'reactivated') targetUserId = (await this.repo.setMirrorStatus({ workosUserId, status: 'active' }))?.userId ?? null;
      await this.repo.recordAudit({
        action: 'member.provision', targetUserId, targetEmail: email, beforeStatus: outcome === 'reactivated' ? 'inactive' : null,
        afterStatus: 'active', reason, outcome: 'success', outcomeCode: null,
      });
    } catch (error) {
      log.error({ tenantId: actor.tenant.id, workosUserId, err: errorName(error) }, 'tenant_accounts.provision.local_failed');
      return result(false, 'failed', 'No pudimos completar el alta. Vuelve a intentarlo: la cuenta no se duplicará.');
    }
    const verb = outcome === 'reactivated' ? 'Reactivaste' : 'Creaste';
    return result(true, 'provisioned', `${verb} la cuenta de ${email}. Comparte con esa persona el enlace de inicio de sesión.`);
  }

  async deactivate(actor: AccountActor, input: { workosUserId: unknown; reason?: unknown }): Promise<AccountResult> {
    const prepared = await this.prepare(actor, input, 'member.deactivate');
    if ('code' in prepared) return prepared;
    const { target, reason, members } = prepared;
    if (target.workosUserId === actor.workosUserId) {
      await this.refuse('member.deactivate', target, reason, 'self_deactivation');
      return result(false, 'self_deactivation', 'No puedes desactivar tu propia cuenta de administrador.');
    }
    const activeAdmins = members.filter((item) => item.status === 'active' && item.role === 'admin');
    if (target.status === 'active' && target.role === 'admin' && activeAdmins.length <= 1) {
      await this.refuse('member.deactivate', target, reason, 'last_admin');
      return result(false, 'last_admin', 'No puedes desactivar al último administrador activo de tu organización.');
    }

    // Step 1: the local block comes first so workers and the usage gateway stop at once.
    const local = await this.repo.setMirrorStatus({ workosUserId: target.workosUserId, status: 'inactive' });
    const audit = (outcome: 'success' | 'failed', code: string | null): AccountAuditEntry => ({
      action: 'member.deactivate', targetUserId: local?.userId ?? null, targetEmail: target.email,
      beforeStatus: target.status, afterStatus: 'inactive', reason, outcome, outcomeCode: code,
    });
    let synced = true;
    try {
      await this.workos.deactivateMembership(actor.organizationId, target.workosUserId);
      await this.workos.revokeSessions(actor.organizationId, target.workosUserId);
    } catch (error) {
      synced = false;
      log.error({ tenantId: actor.tenant.id, workosUserId: target.workosUserId, err: errorName(error) }, 'tenant_accounts.deactivate.workos_failed');
    }
    await this.safeAudit(synced ? audit('success', null) : audit('failed', 'workos_sync_failed'));
    log.info({ tenantId: actor.tenant.id, workosUserId: target.workosUserId, synced }, 'tenant_accounts.deactivated');
    const base = target.status === 'active'
      ? result(true, 'deactivated', `Desactivaste la cuenta de ${target.email}. Sus conversaciones se conservan.`)
      : result(true, 'already_inactive', `La cuenta de ${target.email} ya estaba desactivada.`);
    return synced ? base : {
      ...base,
      message: `${base.message} El acceso ya está bloqueado, pero no pudimos cerrar sus sesiones en el servicio de inicio de sesión. Vuelve a desactivarla para reintentar.`,
    };
  }

  async reactivate(actor: AccountActor, input: { workosUserId: unknown; reason?: unknown }): Promise<AccountResult> {
    const prepared = await this.prepare(actor, input, 'member.reactivate');
    if ('code' in prepared) return prepared;
    const { target, reason } = prepared;
    if (target.status === 'active') return result(true, 'already_active', `La cuenta de ${target.email} ya está activa.`);
    try {
      await this.workos.activateMembership(actor.organizationId, target.workosUserId, target.role);
    } catch (error) {
      log.error({ tenantId: actor.tenant.id, workosUserId: target.workosUserId, err: errorName(error) }, 'tenant_accounts.reactivate.workos_failed');
      await this.safeAudit({
        action: 'member.reactivate', targetUserId: null, targetEmail: target.email, beforeStatus: 'inactive', afterStatus: 'inactive',
        reason, outcome: 'failed', outcomeCode: 'workos_failed',
      });
      return result(false, 'failed', FAILED);
    }
    const local = await this.repo.setMirrorStatus({ workosUserId: target.workosUserId, status: 'active' });
    await this.repo.recordAudit({
      action: 'member.reactivate', targetUserId: local?.userId ?? null, targetEmail: target.email,
      beforeStatus: 'inactive', afterStatus: 'active', reason, outcome: 'success', outcomeCode: null,
    });
    return result(true, 'reactivated', `Reactivaste la cuenta de ${target.email}. Ya puede volver a iniciar sesión.`);
  }

  /** Validates the input and finds the target among this organization's WorkOS memberships (a foreign id never matches). */
  private async prepare(actor: AccountActor, input: { workosUserId: unknown; reason?: unknown }, action: AccountAction) {
    const reason = parseReason(input.reason);
    if (reason === undefined) return result(false, 'invalid_reason', 'El motivo puede tener hasta 500 caracteres.');
    const id = typeof input.workosUserId === 'string' && WORKOS_USER_ID_PATTERN.test(input.workosUserId) ? input.workosUserId : null;
    const members = await this.workos.listMemberships(actor.organizationId);
    const target = id ? members.find((item) => item.workosUserId === id) : undefined;
    if (!target) {
      await this.safeAudit({
        action, targetUserId: null, targetEmail: null, beforeStatus: null, afterStatus: null,
        reason, outcome: 'refused', outcomeCode: 'not_found',
      });
      return result(false, 'not_found', 'No encontramos esa cuenta en tu organización.');
    }
    return { target, reason, members };
  }

  private refuse(action: AccountAction, target: WorkosMember, reason: string | null, code: string): Promise<void> {
    return this.safeAudit({
      action, targetUserId: null, targetEmail: target.email, beforeStatus: target.status, afterStatus: target.status,
      reason, outcome: 'refused', outcomeCode: code,
    });
  }

  private async safeAudit(entry: AccountAuditEntry): Promise<void> {
    try { await this.repo.recordAudit(entry); } catch (error) {
      log.error({ action: entry.action, outcomeCode: entry.outcomeCode, err: errorName(error) }, 'tenant_accounts.audit_failed');
    }
  }
}

/** Optional free-text reason: trimmed, empty → null, over 500 characters → undefined (invalid). */
export function parseReason(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length > 500) return undefined;
  return trimmed || null;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
