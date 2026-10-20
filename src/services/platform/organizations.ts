import { globalRepos } from '../../repos/global';
import { getWorkOS } from '@workos-inc/authkit-nextjs';
import { loggerFor } from '../logger';

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
      const page = await getWorkOS().organizations.listOrganizations({ limit: 100 });
      const organizations = await page.autoPagination();
      const found = organizations.find((organization) => organization.externalId === externalId);
      return found ? { id: found.id, externalId: found.externalId } : undefined;
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

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 64);
  }
  return 'unknown';
}
