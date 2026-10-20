import { withGlobalTransaction } from '../db/global-transaction';
import { assertActivePlatformActor, insertGlobalAuditEvent } from './global-audit';

export type OrganizationStatus = 'active' | 'inactive';
export interface OrganizationMetadata {
  readonly tenantId: string;
  readonly workosOrgId: string | null;
  readonly name: string;
  readonly status: OrganizationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function globalOrganizationsRepo() {
  return {
    async findByWorkosOrgId(workosOrgId: string): Promise<{ tenantId: string; status: OrganizationStatus } | undefined> {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<{ id: string; status: OrganizationStatus }>(
          `SELECT id, status FROM tenants WHERE workos_org_id = $1 LIMIT 1`, [workosOrgId],
        );
        const row = result.rows[0];
        return row ? { tenantId: row.id, status: row.status } : undefined;
      });
    },

    async isActive(workosOrgId: string): Promise<boolean> {
      const org = await this.findByWorkosOrgId(workosOrgId);
      return org?.status === 'active';
    },

    async list(): Promise<OrganizationMetadata[]> {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<{
          id: string; workos_org_id: string | null; name: string; status: OrganizationStatus;
          created_at: Date; updated_at: Date;
        }>(`SELECT id, workos_org_id, name, status, created_at, updated_at FROM tenants ORDER BY name, id`);
        return result.rows.map((row) => ({
          tenantId: row.id, workosOrgId: row.workos_org_id, name: row.name,
          status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        }));
      });
    },

    async getById(tenantId: string): Promise<OrganizationMetadata | undefined> {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<{
          id: string; workos_org_id: string | null; name: string; status: OrganizationStatus;
          created_at: Date; updated_at: Date;
        }>(`SELECT id, workos_org_id, name, status, created_at, updated_at FROM tenants WHERE id = $1`, [tenantId]);
        const row = result.rows[0];
        return row ? {
          tenantId: row.id, workosOrgId: row.workos_org_id, name: row.name,
          status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        } : undefined;
      });
    },

    async createPending(input: {
      operationKey: string; name: string; workosOrgId?: string;
      actorWorkosUserId: string; reason: string;
    }): Promise<{ tenantId: string; created: boolean }> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        await tx.query(
          `INSERT INTO platform_org_operations (operation_key, operation, status, requested_name)
           VALUES ($1, 'create', 'pending', $2) ON CONFLICT (operation_key) DO NOTHING`,
          [input.operationKey, input.name],
        );
        const existingOp = await tx.query<{ tenant_id: string | null; status: string; requested_name: string }>(
          `SELECT tenant_id, status, requested_name FROM platform_org_operations WHERE operation_key = $1 FOR UPDATE`,
          [input.operationKey],
        );
        if (existingOp.rows[0]?.requested_name !== input.name) {
          throw new Error('Organization operation key was already used with different input.');
        }
        if (existingOp.rows[0]?.tenant_id) return { tenantId: existingOp.rows[0].tenant_id, created: false };

        const existingOrg = input.workosOrgId
          ? await tx.query<{ id: string }>('SELECT id FROM tenants WHERE workos_org_id = $1', [input.workosOrgId])
          : { rows: [] as { id: string }[] };
        const tenantId = existingOrg.rows[0]?.id ?? (await tx.query<{ id: string }>(
          `INSERT INTO tenants (kind, name, plan, workos_org_id, status)
           VALUES ('institutional', $1, 'pilot', $2, 'inactive') RETURNING id`,
          [input.name, input.workosOrgId ?? null],
        )).rows[0].id;
        await tx.query(
          `UPDATE platform_org_operations SET tenant_id = $2,
             workos_org_id = COALESCE(platform_org_operations.workos_org_id, $3), updated_at = now()
            WHERE operation_key = $1`,
          [input.operationKey, tenantId, input.workosOrgId ?? null],
        );
        await insertGlobalAuditEvent(tx, {
          actorWorkosUserId: input.actorWorkosUserId,
          action: 'organization.create.staged', scopeType: 'organization_operation',
          scopeId: input.operationKey, outcome: 'success', reason: input.reason,
          metadata: { tenantId },
        });
        return { tenantId, created: !existingOrg.rows[0] };
      });
    },

    async attachWorkosOrganization(input: {
      operationKey: string; workosOrgId: string; actorWorkosUserId: string; reason: string;
    }): Promise<string> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        const operation = await tx.query<{ tenant_id: string | null; workos_org_id: string | null; status: string }>(
          `SELECT tenant_id, workos_org_id, status FROM platform_org_operations WHERE operation_key = $1 FOR UPDATE`, [input.operationKey],
        );
        const tenantId = operation.rows[0]?.tenant_id;
        if (!tenantId) throw new Error('Organization operation was not found.');
        if (operation.rows[0].status === 'complete' && operation.rows[0].workos_org_id === input.workosOrgId) return tenantId;
        await tx.query(`UPDATE tenants SET workos_org_id = $2, status = 'active', updated_at = now() WHERE id = $1`, [tenantId, input.workosOrgId]);
        await tx.query(
          `UPDATE platform_org_operations SET workos_org_id = $2, status = 'complete', updated_at = now()
            WHERE operation_key = $1`, [input.operationKey, input.workosOrgId],
        );
        await insertGlobalAuditEvent(tx, {
          actorWorkosUserId: input.actorWorkosUserId, action: 'organization.create',
          scopeType: 'organization', scopeId: tenantId, outcome: 'success', reason: input.reason,
          metadata: { workosOrgId: input.workosOrgId },
        });
        return tenantId;
      });
    },

    async failOperation(input: {
      operationKey: string; errorCode: string; actorWorkosUserId: string; reason: string;
    }): Promise<void> {
      await withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        await tx.query(
          `UPDATE platform_org_operations SET status = 'reconciliation_required', error_code = $2, updated_at = now()
            WHERE operation_key = $1`, [input.operationKey, input.errorCode],
        );
        await insertGlobalAuditEvent(tx, {
          actorWorkosUserId: input.actorWorkosUserId, action: 'organization.create',
          scopeType: 'organization_operation', scopeId: input.operationKey, outcome: 'failure',
          reason: input.reason, metadata: { errorCode: input.errorCode },
        });
      });
    },

    async update(input: { tenantId: string; actorWorkosUserId: string; name: string; reason: string }): Promise<OrganizationMetadata | undefined> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        const previous = await tx.query<{ name: string; status: OrganizationStatus }>(
          'SELECT name, status FROM tenants WHERE id = $1 FOR UPDATE', [input.tenantId],
        );
        if (!previous.rows[0]) return undefined;
        const updated = await tx.query<{ id: string; workos_org_id: string | null; name: string; status: OrganizationStatus; created_at: Date; updated_at: Date }>(
          `UPDATE tenants SET name = $2, updated_at = now() WHERE id = $1
           RETURNING id, workos_org_id, name, status, created_at, updated_at`, [input.tenantId, input.name],
        );
        await insertGlobalAuditEvent(tx, {
          actorWorkosUserId: input.actorWorkosUserId, action: 'organization.update',
          scopeType: 'organization', scopeId: input.tenantId, outcome: 'success', reason: input.reason,
          metadata: { previousName: previous.rows[0].name, newName: input.name },
        });
        const row = updated.rows[0];
        return { tenantId: row.id, workosOrgId: row.workos_org_id, name: row.name,
          status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
      });
    },

    async setStatus(input: { tenantId: string; actorWorkosUserId: string; status: OrganizationStatus; reason: string }): Promise<boolean> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        const updated = await tx.query<{ status: OrganizationStatus }>(
          `UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1 AND status <> $2 RETURNING status`,
          [input.tenantId, input.status],
        );
        if (!updated.rows[0]) return false;
        await insertGlobalAuditEvent(tx, {
          actorWorkosUserId: input.actorWorkosUserId, action: `organization.${input.status === 'active' ? 'reactivate' : 'deactivate'}`,
          scopeType: 'organization', scopeId: input.tenantId, outcome: 'success', reason: input.reason,
        });
        return true;
      });
    },
  };
}

export type GlobalOrganizationsRepo = ReturnType<typeof globalOrganizationsRepo>;
