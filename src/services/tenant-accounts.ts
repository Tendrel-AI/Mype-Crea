/**
 * KAN-41 (SYS-06): a tenant admin provisions, deactivates and reactivates members of their own
 * tenant (decision KAN-66, Option B). WorkOS is reached only through `WorkosAccountsClient`, so
 * tests inject a fake. No invitation email is ever sent: the admin shares the login link.
 *
 * Partial-failure rule: the local active `users` row is the lock. Identity resolution requires
 * BOTH an active WorkOS membership and that row, so:
 *  - provision does WorkOS first, then the DB. If the DB fails, the WorkOS membership grants
 *    nothing on its own, and a retry finds the same WorkOS user/membership and completes.
 *  - deactivate does the DB first (access ends at once), then WorkOS. If WorkOS fails, the
 *    failure is audited; the leftover membership grants nothing, and calling deactivate again
 *    on the inactive account re-syncs it.
 *  - reactivate does WorkOS first, then the DB, for the same reason as provision.
 */
import { getWorkOS } from '@workos-inc/authkit-nextjs';
import type { Tenant, User } from '../db/with-transaction';
import type { AccountAction, AccountAuditEntry, AccountStatus, TenantAccountsRepo, TenantMember } from '../repos/tenant-accounts';
import { loggerFor } from './logger';

const log = loggerFor('tenant-accounts');

export interface WorkosAccountsClient {
  /** The WorkOS user with this email, created when missing. Never sends an invitation. */
  ensureUser(email: string): Promise<{ id: string }>;
  /** Leave the user with an active membership in the organization (create or reactivate). */
  activateMembership(organizationId: string, workosUserId: string): Promise<void>;
  /** Deactivate the user's membership in the organization, if any. */
  deactivateMembership(organizationId: string, workosUserId: string): Promise<void>;
}

export function createWorkosAccountsClient(): WorkosAccountsClient {
  const memberships = async (organizationId: string, userId: string) =>
    (await getWorkOS().userManagement.listOrganizationMemberships({ organizationId, userId, limit: 100 })).data
      .filter((item) => item.organizationId === organizationId && item.userId === userId);
  return {
    async ensureUser(email) {
      const found = (await getWorkOS().userManagement.listUsers({ email, limit: 1 })).data[0];
      return { id: (found ?? await getWorkOS().userManagement.createUser({ email })).id };
    },
    async activateMembership(organizationId, workosUserId) {
      const existing = await memberships(organizationId, workosUserId);
      if (existing.some((item) => item.status === 'active')) return;
      const inactive = existing.find((item) => item.status === 'inactive');
      if (inactive) await getWorkOS().userManagement.reactivateOrganizationMembership(inactive.id);
      else await getWorkOS().userManagement.createOrganizationMembership({ organizationId, userId: workosUserId });
    },
    async deactivateMembership(organizationId, workosUserId) {
      for (const item of await memberships(organizationId, workosUserId)) {
        if (item.status === 'active') await getWorkOS().userManagement.deactivateOrganizationMembership(item.id);
      }
    },
  };
}

/** The acting admin, always taken from the resolved session identity. */
export interface AccountActor {
  readonly tenant: Tenant;
  readonly user: User;
  readonly organizationId: string;
}

export type AccountResultCode =
  | 'provisioned' | 'already_active' | 'deactivated' | 'reactivated' | 'already_inactive'
  | 'invalid_email' | 'invalid_reason' | 'member_inactive' | 'not_found' | 'self_deactivation' | 'last_admin'
  | 'not_admin' | 'failed';

export interface AccountResult {
  readonly ok: boolean;
  readonly code: AccountResultCode;
  readonly message: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILED = 'No pudimos completar la acción. Vuelve a intentarlo.';

const result = (ok: boolean, code: AccountResultCode, message: string): AccountResult => ({ ok, code, message });

export class TenantAccountService {
  constructor(private readonly repo: TenantAccountsRepo, private readonly workos: WorkosAccountsClient) {}

  async provision(actor: AccountActor, input: { email: unknown; reason?: unknown }): Promise<AccountResult> {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) return result(false, 'invalid_email', 'Escribe un correo electrónico válido.');
    const reason = parseReason(input.reason);
    if (reason === undefined) return result(false, 'invalid_reason', 'El motivo puede tener hasta 500 caracteres.');

    const existing = await this.repo.findByEmail(email);
    if (existing?.status === 'active') return result(true, 'already_active', `${existing.email} ya tiene una cuenta activa en tu organización.`);
    if (existing) return result(false, 'member_inactive', `La cuenta de ${existing.email} está desactivada. Reactívala desde la lista.`);

    const audit = (code: string): AccountAuditEntry => ({
      action: 'member.provision', targetUserId: null, targetEmail: email, beforeStatus: null,
      afterStatus: null, reason, outcome: 'failed', outcomeCode: code,
    });
    let workosUserId: string;
    try {
      workosUserId = (await this.workos.ensureUser(email)).id;
      await this.workos.activateMembership(actor.organizationId, workosUserId);
    } catch (error) {
      log.error({ tenantId: actor.tenant.id, actorUserId: actor.user.id, err: errorName(error) }, 'tenant_accounts.provision.workos_failed');
      await this.safeAudit(audit('workos_failed'));
      return result(false, 'failed', FAILED);
    }
    try {
      const { member } = await this.repo.addMember({ workosUserId, email, reason });
      return result(true, 'provisioned', `Creaste la cuenta de ${member.email}. Comparte con esa persona el enlace de inicio de sesión.`);
    } catch (error) {
      // WorkOS already has the user and membership; they grant nothing without the local row,
      // and a retry reuses them.
      log.error({ tenantId: actor.tenant.id, actorUserId: actor.user.id, workosUserId, err: errorName(error) }, 'tenant_accounts.provision.db_failed_after_workos');
      await this.safeAudit(audit('db_failed'));
      return result(false, 'failed', 'No pudimos completar el alta. Vuelve a intentarlo: la cuenta no se duplicará.');
    }
  }

  async deactivate(actor: AccountActor, input: { userId: unknown; reason?: unknown }): Promise<AccountResult> {
    return this.changeStatus(actor, input, 'inactive');
  }

  async reactivate(actor: AccountActor, input: { userId: unknown; reason?: unknown }): Promise<AccountResult> {
    return this.changeStatus(actor, input, 'active');
  }

  private async changeStatus(actor: AccountActor, input: { userId: unknown; reason?: unknown }, status: AccountStatus): Promise<AccountResult> {
    const action: AccountAction = status === 'inactive' ? 'member.deactivate' : 'member.reactivate';
    const reason = parseReason(input.reason);
    if (reason === undefined) return result(false, 'invalid_reason', 'El motivo puede tener hasta 500 caracteres.');
    const targetUserId = typeof input.userId === 'string' && UUID_PATTERN.test(input.userId) ? input.userId.toLowerCase() : null;
    const refused = (code: 'not_found' | 'self_deactivation'): AccountAuditEntry => ({
      action, targetUserId, targetEmail: null, beforeStatus: null, afterStatus: null, reason, outcome: 'refused', outcomeCode: code,
    });
    if (!targetUserId) {
      await this.repo.recordAudit(refused('not_found'));
      return notFound();
    }
    if (status === 'inactive' && targetUserId === actor.user.id) {
      await this.repo.recordAudit(refused('self_deactivation'));
      return result(false, 'self_deactivation', 'No puedes desactivar tu propia cuenta de administrador.');
    }

    if (status === 'active') {
      // WorkOS first, and only for a member of this tenant: a foreign id never reaches WorkOS.
      const target = await this.repo.findMember(targetUserId);
      if (!target) {
        await this.repo.recordAudit(refused('not_found'));
        return notFound();
      }
      if (target.status === 'active') return result(true, 'already_active', `La cuenta de ${target.email} ya está activa.`);
      try {
        await this.workos.activateMembership(actor.organizationId, target.workosUserId);
      } catch (error) {
        log.error({ tenantId: actor.tenant.id, targetUserId, err: errorName(error) }, 'tenant_accounts.reactivate.workos_failed');
        await this.safeAudit({
          action, targetUserId, targetEmail: target.email, beforeStatus: 'inactive', afterStatus: 'inactive',
          reason, outcome: 'failed', outcomeCode: 'workos_failed',
        });
        return result(false, 'failed', FAILED);
      }
    }

    const changed = await this.repo.setStatus({ targetUserId, status, reason });
    if (changed.kind === 'refused') {
      if (changed.code === 'last_admin') return result(false, 'last_admin', 'No puedes desactivar al último administrador activo de tu organización.');
      return notFound();
    }
    if (status === 'active') {
      return changed.kind === 'changed'
        ? result(true, 'reactivated', `Reactivaste la cuenta de ${changed.member.email}. Ya puede volver a iniciar sesión.`)
        : result(true, 'already_active', `La cuenta de ${changed.member.email} ya está activa.`);
    }
    const synced = await this.syncDeactivation(actor, changed.member, reason);
    const base = changed.kind === 'changed'
      ? result(true, 'deactivated', `Desactivaste la cuenta de ${changed.member.email}. Sus conversaciones se conservan.`)
      : result(true, 'already_inactive', `La cuenta de ${changed.member.email} ya estaba desactivada.`);
    return synced ? base : {
      ...base,
      message: `${base.message} El acceso ya está bloqueado, pero no pudimos actualizar el servicio de inicio de sesión. Si se repite, avisa al equipo de soporte.`,
    };
  }

  /** WorkOS side of a deactivation. Local access is already off, so a failure only needs a retry. */
  private async syncDeactivation(actor: AccountActor, member: TenantMember, reason: string | null): Promise<boolean> {
    try {
      await this.workos.deactivateMembership(actor.organizationId, member.workosUserId);
      return true;
    } catch (error) {
      log.error({ tenantId: actor.tenant.id, targetUserId: member.id, err: errorName(error) }, 'tenant_accounts.deactivate.workos_failed');
      await this.safeAudit({
        action: 'member.deactivate', targetUserId: member.id, targetEmail: member.email, beforeStatus: 'inactive',
        afterStatus: 'inactive', reason, outcome: 'failed', outcomeCode: 'workos_sync_failed',
      });
      return false;
    }
  }

  private async safeAudit(entry: AccountAuditEntry): Promise<void> {
    try { await this.repo.recordAudit(entry); } catch (error) {
      log.error({ action: entry.action, outcomeCode: entry.outcomeCode, err: errorName(error) }, 'tenant_accounts.audit_failed');
    }
  }
}

function notFound(): AccountResult {
  return result(false, 'not_found', 'No encontramos esa cuenta en tu organización.');
}

/** Optional free-text reason: trimmed, empty → null, over 500 characters → undefined (invalid). */
function parseReason(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length > 500) return undefined;
  return trimmed || null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
