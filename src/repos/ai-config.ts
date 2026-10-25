/** Release catalog repository. Every query is tenant scoped; shared writes need a platform actor. */
import { randomUUID } from 'node:crypto';

import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';

import { exportManifest, freezeManifest, validateManifest, type AiConfigManifestV1, type ProviderId } from '../services/ai-config/manifest';

import type { AiReleaseActivation, ProviderAvailability, SharedAiRelease, TenantAiRelease } from './models';

export interface RepositoryActor {
  readonly workosUserId: string;
  readonly platformAdmin: boolean;
  readonly tenantRole?: 'admin' | 'member'
}
type DbTimestamp = string | Date;
interface TenantReleaseDbRow extends Omit<TenantAiRelease, 'createdAt' | 'updatedAt'> {
  readonly createdAt: DbTimestamp;
  readonly updatedAt: DbTimestamp;
}
interface SharedReleaseDbRow extends Omit<SharedAiRelease, 'createdAt' | 'updatedAt'> {
  readonly createdAt: DbTimestamp;
  readonly updatedAt: DbTimestamp;
}
interface ActivationDbRow extends Omit<AiReleaseActivation, 'updatedAt'> {
  readonly updatedAt: DbTimestamp;
}
interface PinnedReleaseRow {
  readonly id: string;
  readonly name: string;
  readonly manifest: AiConfigManifestV1;
  readonly canonicalContent: string;
  readonly contentHash: string;
  readonly status: 'frozen' | 'retired';
  readonly baseSharedReleaseId: string | null;
  readonly allowedOverridePaths: string[];
}
function mapTenantRelease(row: TenantReleaseDbRow): TenantAiRelease {
  return { ...row, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() };
}
function mapSharedRelease(row: SharedReleaseDbRow): SharedAiRelease {
  return { ...row, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() };
}
function mapActivation(row: ActivationDbRow): AiReleaseActivation {
  return { ...row, updatedAt: new Date(row.updatedAt).toISOString() };
}
function requireRelease<T>(release: T | undefined): T {
  if (!release) throw new Error('La configuración no está disponible.');

  return release;

}
export interface AiConfigSyncEvent {
  readonly operationId: string;

  readonly destination: 'git' | 'langsmith';

  readonly action: 'export' | 'prompt_import' | 'prompt_publish' | 'retry';

  readonly status: 'started' | 'succeeded' | 'failed';

  readonly contentHash?: string | null;

  readonly pinnedCommit?: string | null;

  readonly safeErrorCategory?: string | null;

  readonly parentOperationId?: string | null;

}
export function aiConfigRepo(tenant: Tenant, user: User, actor?: RepositoryActor) {
  const actorId = actor?.workosUserId ?? '';

  const asTenantAdmin = async<T>(fn: (tx: TxClient) => Promise<T>) => withTenantTransaction(tenant, user, async tx => {
    // The persisted role is the ceiling; an actor carrying a reduced effective role
    // (developer role switcher, KAN-79) is refused even when the row says admin.
    if (actor?.tenantRole !== undefined && actor.tenantRole !== 'admin') throw new Error('No tienes permisos para administrar la configuración.');
    const ok = await tx.query(`SELECT 1
        FROM users
        WHERE tenant_id=$1 AND id=$2 AND status='active' AND role='admin'`, [tenant.id, user.id]);
    if (!ok.rows.length) throw new Error('No tienes permisos para administrar la configuración.');
    return fn(tx);
  });

  const asPlatformAdmin = async<T>(fn: (tx: TxClient) => Promise<T>) => withTenantTransaction(tenant, user, async tx => {
    if (!actor?.platformAdmin || !/^user_[A-Za-z0-9]+$/.test(actorId)) throw new Error('No tienes permisos para administrar la configuración compartida.');
    // platform_superadmins is RLS-protected by app.is_platform_admin(). Establish
    // that read context only long enough to verify the persisted role; the actor
    // binding used by write policies is set only after both identity checks pass.
    await tx.query(`SELECT set_config('app.is_platform_admin','true', true)`);
    const role = await tx.query(`SELECT 1 FROM platform_superadmins WHERE workos_user_id=$1 AND revoked_at IS NULL`, [actorId]);
    if (!role.rows.length) throw new Error('No tienes permisos para administrar la configuración compartida.');
    const ok = await tx.query(`SELECT 1
        FROM users
        WHERE tenant_id=$1 AND id=$2 AND workos_user_id=$3 AND status='active'`, [tenant.id, user.id, actorId]);
    if (!ok.rows.length) throw new Error('No tienes permisos para administrar la configuración compartida.');
    await tx.query(`SELECT set_config('app.platform_actor_workos_user_id',$1,true)`, [actorId]);
    return fn(tx);
  });

  const tenantRelease = async (tx: TxClient, id: string) => {
    const r = await tx.query<TenantReleaseDbRow>(`SELECT id,
        tenant_id AS "tenantId",
        name,
        status,
        draft_version AS "draftVersion",
        manifest,
        canonical_content AS "canonicalContent",
        content_hash AS "contentHash",
        base_shared_release_id AS "baseSharedReleaseId",
        allowed_override_paths AS "allowedOverridePaths",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
        FROM ai_releases
        WHERE tenant_id=$1 AND id=$2`, [tenant.id, id]);
    return r.rows[0] ? mapTenantRelease(r.rows[0]) : undefined;
  };

  const sharedRelease = async (tx: TxClient, id: string) => {
    const r = await tx.query<SharedReleaseDbRow>(`SELECT id,
        name,
        status,
        draft_version AS "draftVersion",
        manifest,
        canonical_content AS "canonicalContent",
        content_hash AS "contentHash",
        allowed_override_paths AS "allowedOverridePaths",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
        FROM ai_shared_releases
        WHERE id=$1`, [id]);
    return r.rows[0] ? mapSharedRelease(r.rows[0]) : undefined;
  };

  const audit = async (tx: TxClient, action: string, releaseId: string | null, version: number, hash: string | null, target: 'tenant' | 'shared' | 'none' = 'tenant', metadata: Record<string, unknown> = {}) => tx.query(`INSERT INTO ai_config_audit_events(tenant_id,
        actor_user_id,
        action,
        release_id,
        shared_release_id,
        new_version,
        content_hash,
        metadata)
        VALUES($1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb)`, [tenant.id, user.id, action, target === 'tenant' ? releaseId : null, target === 'shared' ? releaseId : null, version, hash, JSON.stringify(metadata)]);

  return {
    async createDraft(input: {
      name: string;
      manifest: AiConfigManifestV1;
      baseSharedReleaseId?: string
    }) {
      return asTenantAdmin(async tx => {
        let paths: string[] = [];
        if (input.baseSharedReleaseId) {
          const base = await sharedRelease(tx, input.baseSharedReleaseId);
          if (!base || base.status !== 'frozen') throw new Error('La configuración compartida ya no está disponible.');
          paths = [...base.allowedOverridePaths];
        } const id = randomUUID();
        const m = validateManifest(input.manifest);
        const canonical = exportManifest(m);
        await tx.query(`INSERT INTO ai_releases(tenant_id,
        id,
        name,
        manifest,
        canonical_content,
        base_shared_release_id,
        allowed_override_paths,
        created_by,
        updated_by)
        VALUES($1,
        $2,
        $3,
        $4::jsonb,
        $5,
        $6,
        $7,
        $8,
        $8)`, [tenant.id, id, input.name, JSON.stringify(m), canonical, input.baseSharedReleaseId ?? null, paths, user.id]);
        await audit(tx, 'draft_created', id, 1, null);
        return requireRelease(await tenantRelease(tx, id));
      });
    },
    async updateDraft(input: {
      releaseId: string;
      expectedVersion: number;
      name?: string;
      manifest: AiConfigManifestV1
    }) {
      return asTenantAdmin(async tx => {
        const old = await tenantRelease(tx, input.releaseId);
        if (!old || old.status !== 'draft' || old.draftVersion !== input.expectedVersion) throw new Error('La configuración cambió; vuelve a cargarla.');
        const m = validateManifest(input.manifest);
        const r = await tx.query(`UPDATE ai_releases
        SET name=COALESCE($4,
        name),
        manifest=$5::jsonb,
        canonical_content=$6,
        draft_version=draft_version+1,
        updated_by=$7,
        updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND draft_version=$3 AND status='draft'`, [tenant.id, input.releaseId, input.expectedVersion, input.name ?? null, JSON.stringify(m), exportManifest(m), user.id]);
        if (r.rowCount !== 1) throw new Error('La configuración cambió; vuelve a cargarla.');
        await audit(tx, 'draft_updated', input.releaseId, input.expectedVersion + 1, null);
        return requireRelease(await tenantRelease(tx, input.releaseId));
      });
    },
    async freezeDraft(input: {
      releaseId: string;
      expectedVersion: number
    }) {
      return asTenantAdmin(async tx => {
        const old = await tenantRelease(tx, input.releaseId);
        if (!old || old.status !== 'draft' || old.draftVersion !== input.expectedVersion) throw new Error('La configuración cambió; vuelve a cargarla.');
        const frozen = freezeManifest(validateManifest(old.manifest));
        const r = await tx.query(`UPDATE ai_releases
        SET status='frozen',
        canonical_content=$4,
        content_hash=$5,
        updated_by=$6,
        updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND draft_version=$3 AND status='draft'`, [tenant.id, input.releaseId, input.expectedVersion, exportManifest(frozen.content), frozen.contentHash, user.id]);
        if (r.rowCount !== 1) throw new Error('La configuración cambió; vuelve a cargarla.');
        await audit(tx, 'release_frozen', input.releaseId, input.expectedVersion, frozen.contentHash);
        return requireRelease(await tenantRelease(tx, input.releaseId));
      });
    },
    async retireRelease(input: {
      releaseId: string;
      expectedVersion: number
    }) {
      return asTenantAdmin(async tx => {
        const r = await tx.query(`UPDATE ai_releases
        SET status='retired',
        updated_by=$4,
        updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND draft_version=$3 AND status='frozen'`, [tenant.id, input.releaseId, input.expectedVersion, user.id]);
        if (r.rowCount !== 1) throw new Error('La configuración cambió; vuelve a cargarla.');
        await audit(tx, 'release_retired', input.releaseId, input.expectedVersion, null);
        return requireRelease(await tenantRelease(tx, input.releaseId));
      });
    },
    async getRelease(id: string) {
      return withTenantTransaction(tenant, user, tx => tenantRelease(tx, id));
    },
    async listReleases() {
      return withTenantTransaction(tenant, user, async tx => {
        const result = await tx.query<TenantReleaseDbRow>(`SELECT id,
        tenant_id AS "tenantId",
        name,
        status,
        draft_version AS "draftVersion",
        manifest,
        canonical_content AS "canonicalContent",
        content_hash AS "contentHash",
        base_shared_release_id AS "baseSharedReleaseId",
        allowed_override_paths AS "allowedOverridePaths",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
        FROM ai_releases
        WHERE tenant_id=$1
        ORDER BY updated_at DESC`, [tenant.id]);
        return result.rows.map(mapTenantRelease);
      });
    },
    async listSharedReleases() {
      const sql = actor?.platformAdmin
        ? `SELECT id,
        name,
        status,
        draft_version AS "draftVersion",
        manifest,
        canonical_content AS "canonicalContent",
        content_hash AS "contentHash",
        allowed_override_paths AS "allowedOverridePaths",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
        FROM ai_shared_releases
        ORDER BY updated_at DESC`
        : `SELECT id,
        name,
        status,
        draft_version AS "draftVersion",
        manifest,
        canonical_content AS "canonicalContent",
        content_hash AS "contentHash",
        allowed_override_paths AS "allowedOverridePaths",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
        FROM ai_shared_releases
        WHERE status='frozen'
        ORDER BY updated_at DESC`;
      const read = async (tx: TxClient) => (await tx.query<SharedReleaseDbRow>(sql)).rows.map(mapSharedRelease);
      return actor?.platformAdmin ? asPlatformAdmin(read) : asTenantAdmin(read);
    },
    async getSharedRelease(id: string) {
      if (actor?.platformAdmin) return asPlatformAdmin(tx => sharedRelease(tx, id));
      return asTenantAdmin(async tx => {
        const release = await sharedRelease(tx, id);
        return release?.status === 'frozen' ? release : undefined;
      });
    },
    async createSharedDraft(input: {
      name: string;
      manifest: AiConfigManifestV1;
      allowedOverridePaths: string[]
    }) {
      return asPlatformAdmin(async tx => {
        const id = randomUUID();
        const m = validateManifest(input.manifest);
        await tx.query(`INSERT INTO ai_shared_releases(id,
        name,
        manifest,
        canonical_content,
        allowed_override_paths,
        created_by_workos_user_id,
        updated_by_workos_user_id)
        VALUES($1,
        $2,
        $3::jsonb,
        $4,
        $5,
        $6,
        $6)`, [id, input.name, JSON.stringify(m), exportManifest(m), input.allowedOverridePaths, actorId]);
        await audit(tx, 'shared_draft_created', id, 1, null, 'shared');
        return requireRelease(await sharedRelease(tx, id));
      });
    },
    async updateSharedDraft(input: {
      releaseId: string;
      expectedVersion: number;
      name?: string;
      manifest: AiConfigManifestV1;
      allowedOverridePaths?: string[]
    }) {
      return asPlatformAdmin(async tx => {
        const old = await sharedRelease(tx, input.releaseId);
        if (!old || old.status !== 'draft' || old.draftVersion !== input.expectedVersion) throw new Error('La configuración cambió; vuelve a cargarla.');
        const m = validateManifest(input.manifest);
        const r = await tx.query(`UPDATE ai_shared_releases
        SET name=COALESCE($3,
        name),
        manifest=$4::jsonb,
        canonical_content=$5,
        allowed_override_paths=COALESCE($6,
        allowed_override_paths),
        draft_version=draft_version+1,
        updated_by_workos_user_id=$7,
        updated_at=now()
        WHERE id=$1 AND draft_version=$2 AND status='draft'`, [input.releaseId, input.expectedVersion, input.name ?? null, JSON.stringify(m), exportManifest(m), input.allowedOverridePaths ?? null, actorId]);
        if (r.rowCount !== 1) throw new Error('La configuración cambió; vuelve a cargarla.');
        await audit(tx, 'shared_draft_updated', input.releaseId, input.expectedVersion + 1, null, 'shared');
        return requireRelease(await sharedRelease(tx, input.releaseId));
      });
    },
    async freezeSharedDraft(input: {
      releaseId: string;
      expectedVersion: number
    }) {
      return asPlatformAdmin(async tx => {
        const old = await sharedRelease(tx, input.releaseId);
        if (!old || old.status !== 'draft' || old.draftVersion !== input.expectedVersion) throw new Error('La configuración cambió; vuelve a cargarla.');
        const f = freezeManifest(validateManifest(old.manifest));
        const frozen = await tx.query(`UPDATE ai_shared_releases
        SET status='frozen',
        canonical_content=$3,
        content_hash=$4,
        updated_by_workos_user_id=$5,
        updated_at=now()
        WHERE id=$1 AND draft_version=$2 AND status='draft'`, [input.releaseId, input.expectedVersion, exportManifest(f.content), f.contentHash, actorId]);
        if (frozen.rowCount !== 1) throw new Error('La configuración cambió; vuelve a cargarla.');
        await audit(tx, 'shared_release_frozen', input.releaseId, input.expectedVersion, f.contentHash, 'shared');
        return requireRelease(await sharedRelease(tx, input.releaseId));
      });
    },
    async retireSharedRelease(input: {
      releaseId: string;
      expectedVersion: number
    }) {
      return asPlatformAdmin(async tx => {
        const r = await tx.query(`UPDATE ai_shared_releases
        SET status='retired',
        updated_by_workos_user_id=$3,
        updated_at=now()
        WHERE id=$1 AND draft_version=$2 AND status='frozen'`, [input.releaseId, input.expectedVersion, actorId]);
        if (r.rowCount !== 1) throw new Error('La configuración cambió; vuelve a cargarla.');
        await audit(tx, 'shared_release_retired', input.releaseId, input.expectedVersion, null, 'shared');
        return requireRelease(await sharedRelease(tx, input.releaseId));
      });
    },
    async activate(input: {
      releaseId: string;
      expectedActivationVersion: number
    }) {
      return asTenantAdmin(async tx => {
        const r = await tx.query<ActivationDbRow>(`INSERT INTO ai_release_activations(tenant_id,
        release_id,
        version,
        updated_by) SELECT $1,$2,$3+1,$4
        WHERE ($3=0 AND NOT EXISTS (
          SELECT 1 FROM ai_release_activations WHERE tenant_id=$1
        )) OR ($3>0 AND EXISTS (
          SELECT 1 FROM ai_release_activations WHERE tenant_id=$1 AND version=$3
        ))
        ON CONFLICT(tenant_id) DO UPDATE
        SET release_id=EXCLUDED.release_id,
        version=ai_release_activations.version+1,
        updated_by=EXCLUDED.updated_by,
        updated_at=now()
        WHERE ai_release_activations.version=$3
        RETURNING release_id AS "releaseId",
        version,
        updated_by AS "updatedBy",
        updated_at AS "updatedAt"
        `, [tenant.id, input.releaseId, input.expectedActivationVersion, user.id]);
        if (!r.rows[0]) throw new Error('La activación cambió o la versión ya no está disponible.');
        await audit(tx, 'release_activated', input.releaseId, r.rows[0].version, null);
        return mapActivation(r.rows[0]);
      });
    },
    async activateShared(input: {
      sharedReleaseId: string;
      expectedSharedVersion: number;
      expectedActivationVersion: number
    }) {
      return asTenantAdmin(async tx => {
        const src = await sharedRelease(tx, input.sharedReleaseId);
        if (!src || src.status !== 'frozen' || src.draftVersion !== input.expectedSharedVersion) throw new Error('La configuración compartida ya no está disponible.');
        const id = randomUUID();
        await tx.query(`INSERT INTO ai_releases(tenant_id,
        id,
        name,
        status,
        draft_version,
        manifest,
        canonical_content,
        content_hash,
        base_shared_release_id,
        allowed_override_paths,
        created_by,
        updated_by)
        VALUES($1,
        $2,
        $3,'frozen',1,
        $4::jsonb,
        $5,
        $6,
        $7,
        $8,
        $9,
        $9)`, [tenant.id, id, src.name, JSON.stringify(src.manifest), src.canonicalContent, src.contentHash, src.id, src.allowedOverridePaths, user.id]);
        const r = await tx.query<ActivationDbRow>(`INSERT INTO ai_release_activations(tenant_id,
        release_id,
        version,
        updated_by) SELECT $1,$2,$3+1,$4
        WHERE ($3=0 AND NOT EXISTS (
          SELECT 1 FROM ai_release_activations WHERE tenant_id=$1
        )) OR ($3>0 AND EXISTS (
          SELECT 1 FROM ai_release_activations WHERE tenant_id=$1 AND version=$3
        ))
        ON CONFLICT(tenant_id) DO UPDATE
        SET release_id=EXCLUDED.release_id,
        version=ai_release_activations.version+1,
        updated_by=EXCLUDED.updated_by,
        updated_at=now()
        WHERE ai_release_activations.version=$3
        RETURNING release_id AS "releaseId",
        version,
        updated_by AS "updatedBy",
        updated_at AS "updatedAt"`, [tenant.id, id, input.expectedActivationVersion, user.id]);
        if (!r.rows[0]) throw new Error('La activación cambió; vuelve a intentarlo.');
        await audit(tx, 'shared_release_activated', id, r.rows[0].version, src.contentHash);
        return mapActivation(r.rows[0]);
      });
    },
    async getActivation() {
      return withTenantTransaction(tenant, user, async tx => {
        const result = await tx.query<ActivationDbRow>(`SELECT release_id AS "releaseId",
        version,
        updated_by AS "updatedBy",
        updated_at AS "updatedAt"
        FROM ai_release_activations
        WHERE tenant_id=$1`, [tenant.id]);
        return result.rows[0] ? mapActivation(result.rows[0]) : undefined;
      });
    },
    async getPinnedRelease(conversationId: string) {
      return withTenantTransaction(tenant, user, async tx => (await tx.query<PinnedReleaseRow>(`SELECT r.id,
        r.name,
        r.manifest,
        r.canonical_content AS "canonicalContent",
        r.content_hash AS "contentHash",
        r.status,
        r.base_shared_release_id AS "baseSharedReleaseId",
        r.allowed_override_paths AS "allowedOverridePaths"
        FROM conversations c
        JOIN ai_releases r ON r.tenant_id=c.tenant_id AND r.id=c.ai_release_id
        WHERE c.tenant_id=$1 AND c.user_id=$2 AND c.id=$3 AND c.configuration_state='pinned'`, [tenant.id, user.id, conversationId])).rows[0]);
    },
    async getProviderAvailability(provider: ProviderId) {
      return withTenantTransaction(tenant, user, async tx => {
        const active = await tx.query(`SELECT 1
        FROM users
        WHERE tenant_id=$1 AND id=$2 AND status='active'`, [tenant.id, user.id]);
        if (!active.rows.length) throw new Error('Tu cuenta ya no tiene acceso activo a esta organización.');
        const r = await tx.query(`SELECT provider,
        enabled,
        version,
        updated_by AS "updatedBy"
        FROM ai_provider_availability
        WHERE tenant_id=$1 AND provider=$2`, [tenant.id, provider]);
        return r.rows[0] as ProviderAvailability | undefined ?? { provider, enabled: true, version: 0, updatedBy: null };
      });
    },
    async listProviderAvailability() {
      return withTenantTransaction(tenant, user, async tx => (await tx.query(`SELECT provider,
        enabled,
        version,
        updated_by AS "updatedBy"
        FROM ai_provider_availability
        WHERE tenant_id=$1`, [tenant.id])).rows);
    },
    async setProviderAvailability(input: {
      provider: ProviderId;
      enabled: boolean;
      expectedVersion: number
    }) {
      return asTenantAdmin(async tx => {
        const r = input.expectedVersion === 0
          ? await tx.query(`INSERT INTO ai_provider_availability(tenant_id,
        provider,
        enabled,
        version,
        updated_by) SELECT $1,
        $2,
        $3,1,
        $4
        WHERE NOT EXISTS(SELECT 1
        FROM ai_provider_availability
        WHERE tenant_id=$1 AND provider=$2)
        ON CONFLICT(tenant_id,
        provider) DO NOTHING
        RETURNING provider,
        enabled,
        version,
        updated_by AS "updatedBy"`, [tenant.id, input.provider, input.enabled, user.id])
          : await tx.query(`UPDATE ai_provider_availability
        SET enabled=$4,
        version=version+1,
        updated_by=$5,
        updated_at=now()
        WHERE tenant_id=$1 AND provider=$2 AND version=$3
        RETURNING provider,
        enabled,
        version,
        updated_by AS "updatedBy"`, [tenant.id, input.provider, input.expectedVersion, input.enabled, user.id]);
        if (!r.rows[0]) throw new Error('La disponibilidad cambió; vuelve a cargarla.');
        await audit(tx, 'provider_availability_changed', null, r.rows[0].version, null, 'none', { provider: input.provider, enabled: input.enabled });
        return r.rows[0] as ProviderAvailability;
      });
    },
    async recordSyncEvent(event: AiConfigSyncEvent) {
      return asTenantAdmin(async tx => {
        if (!/^[0-9a-f-]{36}$/i.test(event.operationId) || (event.parentOperationId && !/^[0-9a-f-]{36}$/i.test(event.parentOperationId)) || (event.contentHash && !/^[0-9a-f]{64}$/.test(event.contentHash)) || (event.pinnedCommit && !/^[0-9a-f]{7,64}$/i.test(event.pinnedCommit)) || (event.safeErrorCategory && !/^[a-z][a-z0-9_]{0,63}$/.test(event.safeErrorCategory))) throw new Error('Los datos de sincronización no son válidos.');
        await tx.query(`INSERT INTO ai_config_audit_events(tenant_id,
        actor_user_id,
        action,
        new_version,
        content_hash,
        metadata)
        VALUES($1,
        $2,'sync_operation',1,
        $3,
        $4::jsonb)`, [tenant.id, user.id, event.contentHash ?? null, JSON.stringify({ type: 'sync_operation', ...event })]);
      });
    },
    async listSyncEvents(input: { limit?: number } = {}) {
      return asTenantAdmin(async tx => (await tx.query(`SELECT metadata,
        occurred_at AS "occurredAt"
        FROM ai_config_audit_events
        WHERE tenant_id=$1 AND metadata->>'type'='sync_operation'
        ORDER BY occurred_at DESC,
        id DESC
        LIMIT $2`, [tenant.id, Math.min(Math.max(input.limit ?? 50, 1), 200)])).rows);
    },
  };

}
export type AiConfigRepo = ReturnType<typeof aiConfigRepo>;

