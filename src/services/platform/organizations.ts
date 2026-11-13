import { globalRepos } from '../../repos/global';
import { getWorkOS } from '@workos-inc/authkit-nextjs';
import { loggerFor } from '../logger';
import { EMAIL_PATTERN, errorName, type WorkosAccountsClient, type WorkosMember } from '../tenant-accounts';

const log = loggerFor('platform.organizations');

export interface WorkosOrganization {
  readonly id: string;
  readonly externalId?: string | null;
}

/** Adapter keeps WorkOS SDK details out of the persistence and lifecycle layers. */
export interface WorkosOrganizationsClient {
  findByExternalId(externalId: string): Promise<WorkosOrganization | undefined>;
  create(input: { name: string; externalId: string }): Promise<WorkosOrganization>;
  update(input: { id: string; name: string }): Promise<WorkosOrganization>;
}

export function createWorkosOrganizationsClient(): WorkosOrganizationsClient {
  return {
    async findByExternalId(externalId) {
      try {
        const found = await getWorkOS().organizations.getOrganizationByExternalId(externalId);
        return { id: found.id, externalId: found.externalId };
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 404) return undefined;
        throw error;
      }
    },
    async create(input) {
      const organization = await getWorkOS().organizations.createOrganization(
        { name: input.name, externalId: input.externalId },
        { idempotencyKey: input.externalId },
      );
      return { id: organization.id, externalId: organization.externalId };
    },
    async update(input) {
      const organization = await getWorkOS().organizations.updateOrganization({
        organization: input.id,
        name: input.name,
      });
      return { id: organization.id, externalId: organization.externalId };
    },
  };
}

export class PlatformOrganizationService {
  private readonly repositories = globalRepos();

  constructor(private readonly workos: WorkosOrganizationsClient) {}

  async create(input: {
    operationKey: string;
    name: string;
    actorWorkosUserId: string;
    reason: string;
  }): Promise<{ tenantId: string; workosOrgId: string }> {
    await this.repositories.organizations.createPending({
      operationKey: input.operationKey,
      name: input.name,
      actorWorkosUserId: input.actorWorkosUserId,
      reason: input.reason,
    });
    let workosOrg: WorkosOrganization;
    try {
      const existing = await this.workos.findByExternalId(input.operationKey);
      workosOrg = existing ?? await this.workos.create({ name: input.name, externalId: input.operationKey });
    } catch (error) {
      await this.recordReconciliationFailure(input, error);
      throw error;
    }

    let tenantId: string;
    try {
      tenantId = await this.repositories.organizations.attachWorkosOrganization({
        operationKey: input.operationKey,
        workosOrgId: workosOrg.id,
        actorWorkosUserId: input.actorWorkosUserId,
        reason: input.reason,
      });
    } catch (error) {
      await this.recordReconciliationFailure(input, error);
      throw error;
    }
    return { tenantId, workosOrgId: workosOrg.id };
  }

  async rename(input: {
    tenantId: string;
    name: string;
    actorWorkosUserId: string;
    reason: string;
  }): Promise<void> {
    const existing = await this.repositories.organizations.getById(input.tenantId);
    if (!existing) throw new Error('Organization was not found.');
    if (!existing.workosOrgId) throw new Error('Organization is not linked to WorkOS.');
    let workosUpdated = false;
    try {
      await this.workos.update({ id: existing.workosOrgId, name: input.name });
      workosUpdated = true;
      const updated = await this.repositories.organizations.update(input);
      if (!updated) throw new Error('Organization was not found.');
    } catch (error) {
      let compensationError: unknown;
      if (workosUpdated) {
        try {
          await this.workos.update({ id: existing.workosOrgId, name: existing.name });
        } catch (rollbackError) {
          compensationError = rollbackError;
          log.error({ organizationId: input.tenantId, err: safeErrorCode(rollbackError) }, 'rename.compensation_failed');
        }
      }
      try {
        await this.repositories.audit.record({
          actorWorkosUserId: input.actorWorkosUserId,
          action: 'organization.update',
          scopeType: 'organization',
          scopeId: input.tenantId,
          outcome: 'failure',
          reason: input.reason,
          metadata: {
            error: safeErrorCode(error),
            compensation: workosUpdated ? (compensationError ? 'failed' : 'succeeded') : 'not_needed',
            ...(compensationError ? { compensationError: safeErrorCode(compensationError) } : {}),
          },
        });
      } catch (auditError) {
        log.error({ organizationId: input.tenantId, err: safeErrorCode(auditError) }, 'rename.failure_audit_failed');
      }
      throw error;
    }
  }

  async setActive(input: {
    tenantId: string;
    active: boolean;
    actorWorkosUserId: string;
    reason: string;
  }): Promise<boolean> {
    return this.repositories.organizations.setStatus({
      tenantId: input.tenantId,
      actorWorkosUserId: input.actorWorkosUserId,
      status: input.active ? 'active' : 'inactive',
      reason: input.reason,
    });
  }

  private async recordReconciliationFailure(
    input: { operationKey: string; actorWorkosUserId: string; reason: string },
    error: unknown,
  ): Promise<void> {
    try {
      await this.repositories.organizations.failOperation({
        operationKey: input.operationKey,
        errorCode: safeErrorCode(error),
        actorWorkosUserId: input.actorWorkosUserId,
        reason: input.reason,
      });
    } catch (recordError) {
      log.error({ operationKey: input.operationKey, err: safeErrorCode(recordError) }, 'create.reconciliation_record_failed');
    }
  }
}

export type AdminProvisionCode = 'provisioned' | 'already_admin' | 'invalid_email' | 'invalid_reason' | 'failed';
export interface AdminProvisionResult { readonly ok: boolean; readonly code: AdminProvisionCode; readonly message: string }

/**
 * D52: a platform operator provisions an organization admin WorkOS-only (user + active membership
 * with role `admin`; no `users` insert, identity resolution mirrors it on first sign-in). The
 * outcome is always audited as `organization.admin_provision`. Idempotent: a retry finds the same
 * WorkOS user and membership. Callers must have passed `requireGlobalMfa()` first.
 */
export class PlatformOrganizationAdminService {
  private readonly repositories = globalRepos();

  constructor(private readonly workos: WorkosAccountsClient) {}

  async provision(input: { tenantId: string; workosOrgId: string; email: unknown; actorWorkosUserId: string; reason: string }): Promise<AdminProvisionResult> {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) return { ok: false, code: 'invalid_email', message: 'Escribe un correo electrónico válido.' };
    const audit = (outcome: 'success' | 'failure', metadata: Record<string, unknown>) => this.safeAudit({
      actorWorkosUserId: input.actorWorkosUserId, action: 'organization.admin_provision', scopeType: 'organization',
      scopeId: input.tenantId, outcome, reason: input.reason, metadata: { email, ...metadata },
    });
    try {
      const user = await this.workos.ensureUser(email);
      const outcome = await this.workos.activateMembership(input.workosOrgId, user.id, 'admin');
      await audit('success', { result: outcome });
      log.info({ tenantId: input.tenantId, workosUserId: user.id, outcome }, 'admin_provision.done');
      return outcome === 'already_active'
        ? { ok: true, code: 'already_admin', message: `${email} ya es administrador de la organización.` }
        : { ok: true, code: 'provisioned', message: `${email} quedó como administrador. Comparte con esa persona el enlace de inicio de sesión.` };
    } catch (error) {
      log.error({ tenantId: input.tenantId, err: errorName(error) }, 'admin_provision.failed');
      await audit('failure', { error: safeErrorCode(error) });
      return { ok: false, code: 'failed', message: 'No pudimos crear al administrador. Puedes reintentarlo desde el detalle de la organización.' };
    }
  }

  /** Active admin memberships, straight from WorkOS. */
  async listAdmins(workosOrgId: string): Promise<ReadonlyArray<WorkosMember>> {
    return (await this.workos.listMemberships(workosOrgId)).filter((item) => item.status === 'active' && item.role === 'admin');
  }

  private async safeAudit(event: Parameters<typeof this.repositories.audit.record>[0]): Promise<void> {
    try { await this.repositories.audit.record(event); } catch (error) {
      log.error({ tenantId: event.scopeId, err: safeErrorCode(error) }, 'admin_provision.audit_failed');
    }
  }
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 64);
  }
  return 'unknown';
}
