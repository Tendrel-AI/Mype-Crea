import { withGlobalTransaction, type GlobalTxClient } from '../db/global-transaction';
import { assertActivePlatformActor, insertGlobalAuditEvent } from './global-audit';
import type { EffectiveModuleVersion, ModuleRolloutRepository, ModuleVersion, OrganizationRolloutResult, RolloutOperation, RolloutScope } from '../services/platform/rollout/service';

interface VersionRow {
  readonly module_id: string;
  readonly version: number;
  readonly config: unknown;
  readonly created_by_workos_user_id: string;
  readonly created_at: Date | string;
  readonly previous_version: number | null;
}
interface OperationRow {
  readonly operation_key: string;
  readonly module_id: string;
  readonly target_scope: RolloutScope['kind'];
  readonly target_organization_ids: string[];
  readonly version: number;
  readonly status: RolloutOperation['status'];
  readonly results: Record<string, OrganizationRolloutResult>;
  readonly created_by_workos_user_id: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function mapVersion(row: VersionRow): ModuleVersion {
  return Object.freeze({ moduleId: row.module_id, version: row.version, config: row.config,
    createdByWorkosUserId: row.created_by_workos_user_id, createdAt: new Date(row.created_at).toISOString(),
    previousVersion: row.previous_version });
}

function mapOperation(row: OperationRow): RolloutOperation {
  const scope: RolloutScope = row.target_scope === 'one'
    ? { kind: 'one', organizationId: row.target_organization_ids[0] }
    : row.target_scope === 'selected'
      ? { kind: 'selected', organizationIds: row.target_organization_ids }
      : row.target_scope === 'all' ? { kind: 'all' } : { kind: 'default' };
  return Object.freeze({ operationKey: row.operation_key, moduleId: row.module_id, scope,
    organizationIds: Object.freeze([...row.target_organization_ids]), version: row.version, status: row.status,
    results: Object.freeze(Object.values(row.results ?? {})), createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString() });
}

async function getOperationTx(tx: GlobalTxClient, operationKey: string): Promise<RolloutOperation | undefined> {
  const result = await tx.query<OperationRow>(`SELECT operation_key, module_id, target_scope,
      target_organization_ids, version, status, results, created_by_workos_user_id, created_at, updated_at
    FROM platform_module_operations WHERE operation_key = $1`, [operationKey]);
  return result.rows[0] ? mapOperation(result.rows[0]) : undefined;
}

async function lockModuleVersionSequence(tx: GlobalTxClient, moduleId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('platform_module_versions'), hashtext($1))`, [moduleId]);
}

export function platformConfigRepo(): ModuleRolloutRepository {
  return {
    async listActiveOrganizationIds() {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<{ readonly id: string }>(`SELECT id FROM tenants WHERE status = 'active' ORDER BY id`);
        return result.rows.map((row) => row.id);
      });
    },
    async getVersion(moduleId, version) {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<VersionRow>(`SELECT module_id, version, config, created_by_workos_user_id,
            created_at, previous_version FROM platform_module_versions WHERE module_id=$1 AND version=$2`, [moduleId, version]);
        return result.rows[0] ? mapVersion(result.rows[0]) : undefined;
      });
    },
    async listVersions(moduleId) {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<VersionRow>(`SELECT module_id, version, config, created_by_workos_user_id,
            created_at, previous_version FROM platform_module_versions WHERE module_id=$1 ORDER BY version DESC`, [moduleId]);
        return result.rows.map(mapVersion);
      });
    },
    async createVersion(input) {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        await lockModuleVersionSequence(tx, input.moduleId);
        const latest = await tx.query<{ readonly version: number | null }>(`SELECT max(version) AS version FROM platform_module_versions WHERE module_id=$1`, [input.moduleId]);
        const previousVersion = latest.rows[0]?.version ?? null;
        const sharedReleaseId = typeof input.config === 'object' && input.config !== null
          ? (input.config as Record<string, unknown>).sharedReleaseId ?? null : null;
        const inserted = await tx.query<VersionRow>(`INSERT INTO platform_module_versions
            (module_id, version, config, shared_release_id, created_by_workos_user_id, previous_version)
          VALUES ($1, $2, $3::jsonb, $4, $5, $6)
          RETURNING module_id, version, config, created_by_workos_user_id, created_at, previous_version`,
        [input.moduleId, (previousVersion ?? 0) + 1, JSON.stringify(input.config), sharedReleaseId, input.actorWorkosUserId, previousVersion]);
        await insertGlobalAuditEvent(tx, { actorWorkosUserId: input.actorWorkosUserId, action: 'module_version_created',
          scopeType: 'module', scopeId: input.moduleId, priorVersion: previousVersion?.toString() ?? null,
          newVersion: inserted.rows[0].version.toString(), outcome: 'success' });
        return mapVersion(inserted.rows[0]);
      });
    },
    async publishAiVersion(input) {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        await lockModuleVersionSequence(tx, 'ai');
        const existing = await tx.query<VersionRow & {
          readonly shared_release_id: string;
          readonly release_name: string;
          readonly release_content_hash: string;
          readonly allowed_override_paths: string[];
        }>(`SELECT v.module_id, v.version, v.config, v.created_by_workos_user_id, v.created_at,
                   v.previous_version, v.shared_release_id, r.name AS release_name,
                   r.content_hash AS release_content_hash, r.allowed_override_paths
              FROM platform_module_versions v
              JOIN ai_shared_releases r ON r.id = v.shared_release_id
             WHERE v.operation_key = $1`, [input.operationKey]);
        if (existing.rows[0]) {
          const row = existing.rows[0];
          const isSame = row.module_id === 'ai' && row.release_name === input.name &&
            row.release_content_hash === input.contentHash && sameIds(row.allowed_override_paths, input.allowedOverridePaths);
          if (!isSame) throw new Error('Operation key is already used by a different AI publication.');
          return { version: mapVersion(row), sharedReleaseId: row.shared_release_id };
        }

        const release = await tx.query<{ readonly id: string }>(`INSERT INTO ai_shared_releases
            (name, status, draft_version, manifest, canonical_content, content_hash,
             allowed_override_paths, created_by_workos_user_id, updated_by_workos_user_id, frozen_at)
          VALUES ($1, 'frozen', 1, $2::jsonb, $3, $4, $5, $6, $6, now()) RETURNING id`,
        [input.name, JSON.stringify(input.manifest), input.canonicalContent, input.contentHash,
          input.allowedOverridePaths, input.actorWorkosUserId]);
        const latest = await tx.query<{ readonly version: number | null }>(`SELECT max(version) AS version FROM platform_module_versions WHERE module_id='ai'`);
        const previousVersion = latest.rows[0]?.version ?? null;
        const version = await tx.query<VersionRow>(`INSERT INTO platform_module_versions
            (module_id, version, config, shared_release_id, created_by_workos_user_id, previous_version, operation_key)
          VALUES ('ai', $1, $2::jsonb, $3, $4, $5, $6)
          RETURNING module_id, version, config, created_by_workos_user_id, created_at, previous_version`,
        [(previousVersion ?? 0) + 1, JSON.stringify({ sharedReleaseId: release.rows[0].id }), release.rows[0].id,
          input.actorWorkosUserId, previousVersion, input.operationKey]);
        await insertGlobalAuditEvent(tx, { actorWorkosUserId: input.actorWorkosUserId,
          action: 'ai_shared_release_published', scopeType: 'ai_shared_release', scopeId: release.rows[0].id,
          newVersion: version.rows[0].version.toString(), outcome: 'success', reason: input.reason,
          metadata: { contentHash: input.contentHash } });
        await insertGlobalAuditEvent(tx, { actorWorkosUserId: input.actorWorkosUserId,
          action: 'module_version_created', scopeType: 'module', scopeId: 'ai',
          priorVersion: previousVersion?.toString() ?? null, newVersion: version.rows[0].version.toString(),
          outcome: 'success', reason: input.reason, metadata: { operationKey: input.operationKey, sharedReleaseId: release.rows[0].id } });
        return { version: mapVersion(version.rows[0]), sharedReleaseId: release.rows[0].id };
      });
    },
    async getCurrentVersion(moduleId, organizationId) {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<{ readonly version: number | null }>(`SELECT version FROM platform_module_assignments WHERE module_id=$1 AND organization_id=$2`, [moduleId, organizationId]);
        return result.rows[0]?.version ?? null;
      });
    },
    async getEffectiveVersion(moduleId, organizationId, actorWorkosUserId): Promise<EffectiveModuleVersion> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query<{
          readonly assignment_version: number | null;
          readonly assignment_release_id: string | null;
          readonly default_version: number | null;
          readonly default_release_id: string | null;
          readonly tenant_release_id: string | null;
        }>(`SELECT a.version AS assignment_version, av.shared_release_id AS assignment_release_id,
                   d.version AS default_version, dv.shared_release_id AS default_release_id,
                   app.platform_tenant_ai_release($2::uuid) AS tenant_release_id
              FROM (SELECT 1) seed
              LEFT JOIN platform_module_assignments a
                ON a.module_id=$1 AND a.organization_id=$2
              LEFT JOIN platform_module_versions av ON av.module_id=a.module_id AND av.version=a.version
              LEFT JOIN platform_module_defaults d ON d.module_id=$1
              LEFT JOIN platform_module_versions dv ON dv.module_id=d.module_id AND dv.version=d.version`,
        [moduleId, organizationId]);
        const row = result.rows[0];
        if (!row) return { source: 'unconfigured', moduleVersion: null, releaseId: null };
        if (row.assignment_version !== null) return { source: 'organization_assignment', moduleVersion: row.assignment_version, releaseId: row.assignment_release_id };
        if (row.tenant_release_id) return { source: 'tenant_activation', moduleVersion: null, releaseId: row.tenant_release_id };
        if (row.default_version !== null) return { source: 'global_default', moduleVersion: row.default_version, releaseId: row.default_release_id };
        return { source: 'unconfigured', moduleVersion: null, releaseId: null };
      });
    },
    async getDefaultVersion(moduleId) {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<{ readonly version: number }>(`SELECT version FROM platform_module_defaults WHERE module_id=$1`, [moduleId]);
        return result.rows[0]?.version ?? null;
      });
    },
    async getOperation(operationKey) {
      return withGlobalTransaction((tx) => getOperationTx(tx, operationKey));
    },
    async listOperationsForOrganization(organizationId) {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<OperationRow>(`SELECT operation_key, module_id, target_scope,
            target_organization_ids, version, status, results, created_by_workos_user_id, created_at, updated_at
          FROM platform_module_operations
          WHERE target_organization_ids @> ARRAY[$1::uuid]
          ORDER BY updated_at DESC, created_at DESC`, [organizationId]);
        return result.rows.map(mapOperation);
      });
    },
    async beginOperation(input) {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        await tx.query(`INSERT INTO platform_module_operations
            (operation_key, module_id, target_scope, target_organization_ids, version, status, created_by_workos_user_id)
          VALUES ($1, $2, $3, $4::uuid[], $5, 'pending', $6) ON CONFLICT (operation_key) DO NOTHING`,
        [input.operationKey, input.moduleId, input.scope.kind, input.organizationIds, input.version, input.actorWorkosUserId]);
        const operation = await getOperationTx(tx, input.operationKey);
        if (!operation || operation.moduleId !== input.moduleId || operation.version !== input.version ||
            operation.scope.kind !== input.scope.kind || !sameIds(operation.organizationIds, input.organizationIds)) {
          throw new Error('Operation key is already used by a different rollout.');
        }
        return operation;
      });
    },
    async applyOrganization(input) {
      try {
        return await withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        const operation = await getOperationTx(tx, input.operationKey);
        if (!operation || operation.moduleId !== input.moduleId || operation.version !== input.version || !operation.organizationIds.includes(input.organizationId)) {
          throw new Error('Rollout operation does not include this organization.');
        }
        const existing = operation.results.find((result) => result.organizationId === input.organizationId);
        if (existing?.status === 'succeeded') return existing;
        const current = await tx.query<{ readonly version: number }>(`SELECT version FROM platform_module_assignments WHERE module_id=$1 AND organization_id=$2 FOR UPDATE`, [input.moduleId, input.organizationId]);
        const previousVersion = current.rows[0]?.version ?? null;
        await tx.query(`INSERT INTO platform_module_assignments(module_id, organization_id, version, updated_by_workos_user_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT(module_id,organization_id) DO UPDATE
          SET version=EXCLUDED.version, updated_by_workos_user_id=EXCLUDED.updated_by_workos_user_id, updated_at=now()`,
        [input.moduleId, input.organizationId, input.version, input.actorWorkosUserId]);
        const result: OrganizationRolloutResult = { organizationId: input.organizationId, status: 'succeeded', previousVersion, version: input.version };
        await saveOperationResult(tx, input.operationKey, result);
        await insertGlobalAuditEvent(tx, { actorWorkosUserId: input.actorWorkosUserId, action: 'module_rollout_applied',
          scopeType: 'organization', scopeId: input.organizationId, priorVersion: previousVersion?.toString() ?? null,
          newVersion: input.version.toString(), outcome: 'success', reason: input.reason,
          metadata: { moduleId: input.moduleId, operationKey: input.operationKey } });
        return result;
        });
      } catch {
        return withGlobalTransaction(async (tx) => {
          await assertActivePlatformActor(tx, input.actorWorkosUserId);
          const operation = await getOperationTx(tx, input.operationKey);
          if (!operation || operation.moduleId !== input.moduleId || operation.version !== input.version || !operation.organizationIds.includes(input.organizationId)) {
            throw new Error('Rollout operation does not include this organization.');
          }
          const existing = operation.results.find((result) => result.organizationId === input.organizationId);
          if (existing?.status === 'succeeded') return existing;
          const result: OrganizationRolloutResult = { organizationId: input.organizationId, status: 'failed',
            previousVersion: operation.results.find((item) => item.organizationId === input.organizationId)?.previousVersion ?? null,
            version: input.version, error: 'Configuration could not be applied.' };
          await saveOperationResult(tx, input.operationKey, result);
          await insertGlobalAuditEvent(tx, { actorWorkosUserId: input.actorWorkosUserId, action: 'module_rollout_applied',
            scopeType: 'organization', scopeId: input.organizationId, priorVersion: result.previousVersion?.toString() ?? null,
            newVersion: input.version.toString(), outcome: 'failure', reason: input.reason,
            metadata: { moduleId: input.moduleId, operationKey: input.operationKey, error: result.error } });
          return result;
        });
      }
    },
    async recordOrganizationFailure(input) {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        const operation = await getOperationTx(tx, input.operationKey);
        if (!operation || operation.moduleId !== input.moduleId || operation.version !== input.version || !operation.organizationIds.includes(input.organizationId)) {
          throw new Error('Rollout operation does not include this organization.');
        }
        const existing = operation.results.find((result) => result.organizationId === input.organizationId);
        if (existing?.status === 'succeeded') return existing;
        const current = await tx.query<{ readonly version: number }>(`SELECT version FROM platform_module_assignments WHERE module_id=$1 AND organization_id=$2`, [input.moduleId, input.organizationId]);
        const result: OrganizationRolloutResult = { organizationId: input.organizationId, status: 'failed',
          previousVersion: current.rows[0]?.version ?? null, version: input.version, error: input.error };
        await saveOperationResult(tx, input.operationKey, result);
        await insertGlobalAuditEvent(tx, { actorWorkosUserId: input.actorWorkosUserId, action: 'module_rollout_applied',
          scopeType: 'organization', scopeId: input.organizationId, priorVersion: result.previousVersion?.toString() ?? null,
          newVersion: input.version.toString(), outcome: 'failure', reason: input.reason,
          metadata: { moduleId: input.moduleId, operationKey: input.operationKey, error: input.error } });
        return result;
      });
    },
    async setDefault(input) {
      await withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        const current = await tx.query<{ readonly version: number }>(`SELECT version FROM platform_module_defaults WHERE module_id=$1 FOR UPDATE`, [input.moduleId]);
        const previousVersion = current.rows[0]?.version ?? null;
        await tx.query(`INSERT INTO platform_module_defaults(module_id, version, updated_by_workos_user_id)
          VALUES ($1,$2,$3) ON CONFLICT(module_id) DO UPDATE
          SET version=EXCLUDED.version, updated_by_workos_user_id=EXCLUDED.updated_by_workos_user_id, updated_at=now()`,
        [input.moduleId, input.version, input.actorWorkosUserId]);
        await insertGlobalAuditEvent(tx, { actorWorkosUserId: input.actorWorkosUserId, action: 'module_default_applied',
          scopeType: 'module', scopeId: input.moduleId, priorVersion: previousVersion?.toString() ?? null,
          newVersion: input.version.toString(), outcome: 'success', reason: input.reason,
          metadata: { operationKey: input.operationKey } });
      });
    },
    async finishOperation(operationKey, status, actorWorkosUserId) {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        await tx.query(`UPDATE platform_module_operations SET status=$2, updated_at=now() WHERE operation_key=$1`, [operationKey, status]);
        const operation = await getOperationTx(tx, operationKey);
        if (!operation) throw new Error('Rollout operation was not found.');
        return operation;
      });
    },
  };
}

async function saveOperationResult(tx: GlobalTxClient, operationKey: string, result: OrganizationRolloutResult): Promise<void> {
  await tx.query(`UPDATE platform_module_operations
    SET results = jsonb_set(results, ARRAY[$2], $3::jsonb, true), updated_at=now()
    WHERE operation_key=$1`, [operationKey, result.organizationId, JSON.stringify(result)]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]);
}
