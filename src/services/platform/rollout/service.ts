import type { PlatformModule } from '../modules/contract';
import { assertExecutable } from '../../ai-config/execution';
import { captureRuntimeIdentity } from '../../ai-config/baseline';
import { ProviderRegistry } from '../../ai-config/provider-registry';
import { exportManifest, freezeManifest, type AiConfigManifestV1 } from '../../ai-config/manifest';

export type RolloutScope =
  | { readonly kind: 'default' }
  | { readonly kind: 'one'; readonly organizationId: string }
  | { readonly kind: 'selected'; readonly organizationIds: readonly string[] }
  | { readonly kind: 'all' };

export interface ModuleVersion {
  readonly moduleId: string;
  readonly version: number;
  readonly config: unknown;
  readonly createdByWorkosUserId: string;
  readonly createdAt: string;
  readonly previousVersion: number | null;
}

export interface OrganizationRolloutResult {
  readonly organizationId: string;
  readonly status: 'succeeded' | 'failed' | 'skipped';
  readonly previousVersion: number | null;
  readonly version: number;
  readonly error?: string;
}

export interface RolloutOperation {
  readonly operationKey: string;
  readonly moduleId: string;
  readonly scope: RolloutScope;
  readonly organizationIds: readonly string[];
  readonly version: number;
  readonly status: 'pending' | 'complete' | 'partial' | 'failed';
  readonly results: readonly OrganizationRolloutResult[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EffectiveModuleVersion {
  readonly source: 'organization_assignment' | 'tenant_activation' | 'global_default' | 'unconfigured';
  readonly moduleVersion: number | null;
  readonly releaseId: string | null;
}

/** Storage adapter owns transactions, per-organization isolation, and durable idempotency. */
export interface ModuleRolloutRepository {
  listActiveOrganizationIds(): Promise<readonly string[]>;
  getVersion(moduleId: string, version: number): Promise<ModuleVersion | undefined>;
  listVersions(moduleId: string): Promise<readonly ModuleVersion[]>;
  createVersion(input: { moduleId: string; config: unknown; actorWorkosUserId: string }): Promise<ModuleVersion>;
  publishAiVersion(input: {
    operationKey: string;
    name: string;
    manifest: AiConfigManifestV1;
    canonicalContent: string;
    contentHash: string;
    allowedOverridePaths: readonly string[];
    actorWorkosUserId: string;
    reason?: string;
  }): Promise<{ readonly version: ModuleVersion; readonly sharedReleaseId: string }>;
  getCurrentVersion(moduleId: string, organizationId: string): Promise<number | null>;
  getEffectiveVersion(moduleId: string, organizationId: string, actorWorkosUserId: string): Promise<EffectiveModuleVersion>;
  getDefaultVersion(moduleId: string): Promise<number | null>;
  getOperation(operationKey: string): Promise<RolloutOperation | undefined>;
  listOperationsForOrganization(organizationId: string): Promise<readonly RolloutOperation[]>;
  beginOperation(input: { operationKey: string; moduleId: string; scope: RolloutScope; organizationIds: readonly string[]; version: number; actorWorkosUserId: string; reason?: string }): Promise<RolloutOperation>;
  applyOrganization(input: { operationKey: string; moduleId: string; organizationId: string; version: number; actorWorkosUserId: string; reason?: string }): Promise<OrganizationRolloutResult>;
  recordOrganizationFailure(input: { operationKey: string; moduleId: string; organizationId: string; version: number; actorWorkosUserId: string; reason?: string; error: string }): Promise<OrganizationRolloutResult>;
  setDefault(input: { operationKey: string; moduleId: string; version: number; actorWorkosUserId: string; reason?: string }): Promise<void>;
  finishOperation(operationKey: string, status: RolloutOperation['status'], actorWorkosUserId: string): Promise<RolloutOperation>;
}

export type ModuleConfigCheck = (input: { moduleId: string; config: unknown; organizationId?: string }) => Promise<void>;
export type PlatformAuthorization = (actorWorkosUserId: string) => Promise<void>;
export type AiManifestValidator = (manifest: AiConfigManifestV1) => Promise<void>;

export interface RolloutPreview {
  readonly moduleId: string;
  readonly version: number;
  readonly scope: RolloutScope;
  readonly organizations: readonly {
    readonly organizationId: string;
    readonly currentVersion: number | null;
    readonly effectiveVersion: EffectiveModuleVersion;
    readonly compatible: boolean;
    readonly error?: string;
  }[];
  readonly defaultVersion: number | null;
}

export class ModuleRolloutService {
  constructor(
    private readonly modules: (id: string) => PlatformModule | undefined,
    private readonly repository: ModuleRolloutRepository,
    private readonly authorize: PlatformAuthorization,
    private readonly checkConfig: ModuleConfigCheck,
    private readonly validateAiManifest: AiManifestValidator = validateCurrentAiManifest,
  ) {}

  async publishVersion(input: { actorWorkosUserId: string; moduleId: string; config: unknown }): Promise<ModuleVersion> {
    await this.authorize(input.actorWorkosUserId);
    const platformModule = this.requireModule(input.moduleId);
    const config = platformModule.validateConfig(input.config);
    await this.checkConfig({ moduleId: platformModule.id, config });
    return this.repository.createVersion({ moduleId: platformModule.id, config, actorWorkosUserId: input.actorWorkosUserId });
  }

  async publishAiModuleVersion(input: {
    actorWorkosUserId: string;
    name: string;
    manifest: unknown;
    allowedOverridePaths: readonly string[];
    operationKey: string;
    reason?: string;
  }): Promise<{ readonly moduleVersion: ModuleVersion; readonly sharedReleaseId: string }> {
    await this.authorize(input.actorWorkosUserId);
    const platformModule = this.requireModule('ai');
    if (!isOperationKey(input.operationKey)) throw new Error('A valid operation key is required.');
    if (!input.name.trim()) throw new Error('A release name is required.');
    const frozen = freezeManifest(input.manifest);
    await this.validateAiManifest(frozen.content);
    const allowedOverridePaths = validateOverridePaths(input.allowedOverridePaths);
    const published = await this.repository.publishAiVersion({
      operationKey: input.operationKey,
      name: input.name.trim(),
      manifest: frozen.content,
      canonicalContent: exportManifest(frozen.content),
      contentHash: frozen.contentHash,
      allowedOverridePaths,
      actorWorkosUserId: input.actorWorkosUserId,
      reason: input.reason,
    });
    platformModule.validateConfig(published.version.config);
    return Object.freeze({ moduleVersion: published.version, sharedReleaseId: published.sharedReleaseId });
  }

  async listVersions(input: { actorWorkosUserId: string; moduleId: string }): Promise<readonly ModuleVersion[]> {
    await this.authorize(input.actorWorkosUserId);
    this.requireModule(input.moduleId);
    return this.repository.listVersions(input.moduleId);
  }

  async getOperation(input: { actorWorkosUserId: string; operationKey: string }): Promise<RolloutOperation | undefined> {
    await this.authorize(input.actorWorkosUserId);
    return this.repository.getOperation(input.operationKey);
  }

  async listOperationsForOrganization(input: { actorWorkosUserId: string; organizationId: string }): Promise<readonly RolloutOperation[]> {
    await this.authorize(input.actorWorkosUserId);
    return this.repository.listOperationsForOrganization(input.organizationId);
  }

  async getEffectiveVersion(input: { actorWorkosUserId: string; moduleId: string; organizationId: string }): Promise<EffectiveModuleVersion> {
    await this.authorize(input.actorWorkosUserId);
    this.requireModule(input.moduleId);
    return this.repository.getEffectiveVersion(input.moduleId, input.organizationId, input.actorWorkosUserId);
  }

  async preview(input: { actorWorkosUserId: string; moduleId: string; version: number; scope: RolloutScope }): Promise<RolloutPreview> {
    await this.authorize(input.actorWorkosUserId);
    const version = await this.requireVersion(input.moduleId, input.version);
    const platformModule = this.requireModule(input.moduleId);
    const organizations = await this.resolveOrganizations(input.scope);
    const current = await Promise.all(organizations.map(async (organizationId) => {
      const currentVersion = await this.repository.getCurrentVersion(platformModule.id, organizationId);
      const effectiveVersion = await this.repository.getEffectiveVersion(platformModule.id, organizationId, input.actorWorkosUserId);
      try {
        await this.checkConfig({ moduleId: platformModule.id, config: version.config, organizationId });
        return { organizationId, currentVersion, effectiveVersion, compatible: true as const };
      } catch {
        return { organizationId, currentVersion, effectiveVersion, compatible: false as const, error: 'La configuración no se puede aplicar a esta organización.' };
      }
    }));
    return Object.freeze({
      moduleId: platformModule.id,
      version: version.version,
      scope: input.scope,
      organizations: Object.freeze(current),
      defaultVersion: await this.repository.getDefaultVersion(platformModule.id),
    });
  }

  async apply(input: { actorWorkosUserId: string; moduleId: string; version: number; scope: RolloutScope; operationKey: string; reason?: string }): Promise<RolloutOperation> {
    await this.authorize(input.actorWorkosUserId);
    const platformModule = this.requireModule(input.moduleId);
    const version = await this.requireVersion(platformModule.id, input.version);
    const existing = await this.repository.getOperation(input.operationKey);
    if (existing) {
      const sameTargets = input.scope.kind === 'all' || input.scope.kind === 'default'
        ? true
        : sameIds(existing.organizationIds, await this.resolveOrganizations(input.scope));
      if (existing.moduleId !== platformModule.id || existing.version !== version.version || existing.scope.kind !== input.scope.kind || !sameTargets) {
        throw new Error('Operation key is already used by a different rollout.');
      }
      return this.retryExisting(input.actorWorkosUserId, existing, version, platformModule, input.reason);
    }

    const organizationIds = await this.resolveOrganizations(input.scope);
    if (input.scope.kind === 'default') await this.checkConfig({ moduleId: platformModule.id, config: version.config });
    const compatibleOrganizations = new Set<string>();
    await Promise.all(organizationIds.map(async (organizationId) => {
      try {
        await this.checkConfig({ moduleId: platformModule.id, config: version.config, organizationId });
        compatibleOrganizations.add(organizationId);
      } catch {
        // The operation stores this target as a failure and continues other organizations.
      }
    }));
    await this.repository.beginOperation({
      operationKey: input.operationKey,
      moduleId: platformModule.id,
      scope: input.scope,
      organizationIds,
      version: version.version,
      actorWorkosUserId: input.actorWorkosUserId,
      reason: input.reason,
    });
    if (input.scope.kind === 'default') {
      await this.repository.setDefault({ operationKey: input.operationKey, moduleId: platformModule.id, version: version.version, actorWorkosUserId: input.actorWorkosUserId, reason: input.reason });
    } else {
      await Promise.all(organizationIds.map((organizationId) => compatibleOrganizations.has(organizationId)
        ? this.repository.applyOrganization({ operationKey: input.operationKey, moduleId: platformModule.id, organizationId,
          version: version.version, actorWorkosUserId: input.actorWorkosUserId, reason: input.reason })
        : this.repository.recordOrganizationFailure({ operationKey: input.operationKey, moduleId: platformModule.id, organizationId,
          version: version.version, actorWorkosUserId: input.actorWorkosUserId, reason: input.reason,
          error: 'Configuration validation failed for this organization.' })));
    }
    return this.completeOperation(input.operationKey, input.actorWorkosUserId);
  }

  async retry(input: { actorWorkosUserId: string; operationKey: string; reason?: string }): Promise<RolloutOperation> {
    await this.authorize(input.actorWorkosUserId);
    const operation = await this.repository.getOperation(input.operationKey);
    if (!operation) throw new Error('Rollout operation was not found.');
    const platformModule = this.requireModule(operation.moduleId);
    const version = await this.requireVersion(operation.moduleId, operation.version);
    return this.retryExisting(input.actorWorkosUserId, operation, version, platformModule, input.reason);
  }

  async rollback(input: { actorWorkosUserId: string; moduleId: string; targetVersion: number; scope: RolloutScope; operationKey: string; reason: string }): Promise<RolloutOperation> {
    await this.authorize(input.actorWorkosUserId);
    const version = await this.requireVersion(input.moduleId, input.targetVersion);
    return this.apply({ ...input, version: version.version });
  }

  private async retryExisting(actor: string, operation: RolloutOperation, version: ModuleVersion, platformModule: PlatformModule, reason?: string): Promise<RolloutOperation> {
    if (operation.status === 'complete') return operation;
    if (operation.scope.kind === 'default') {
      await this.repository.setDefault({ operationKey: operation.operationKey, moduleId: platformModule.id, version: version.version, actorWorkosUserId: actor, reason });
      return this.repository.finishOperation(operation.operationKey, 'complete', actor);
    }
    for (const organizationId of operation.organizationIds) {
      const prior = operation.results.find((result) => result.organizationId === organizationId);
      if (prior?.status === 'succeeded') continue;
      try {
        await this.checkConfig({ moduleId: platformModule.id, config: version.config, organizationId });
        await this.repository.applyOrganization({ operationKey: operation.operationKey, moduleId: platformModule.id, organizationId, version: version.version, actorWorkosUserId: actor, reason });
      } catch {
        await this.repository.recordOrganizationFailure({ operationKey: operation.operationKey, moduleId: platformModule.id, organizationId,
          version: version.version, actorWorkosUserId: actor, reason, error: 'Configuration validation failed for this organization.' });
      }
    }
    return this.completeOperation(operation.operationKey, actor);
  }

  private async completeOperation(operationKey: string, actor: string): Promise<RolloutOperation> {
    const operation = await this.repository.getOperation(operationKey);
    if (!operation) throw new Error('Rollout operation was not found.');
    if (operation.scope.kind === 'default') return this.repository.finishOperation(operationKey, 'complete', actor);
    const results = operation.results;
    const succeeded = results.filter((result) => result.status === 'succeeded').length;
    const status = succeeded === results.length ? 'complete' : succeeded > 0 ? 'partial' : 'failed';
    return this.repository.finishOperation(operationKey, status, actor);
  }

  private async resolveOrganizations(scope: RolloutScope): Promise<readonly string[]> {
    if (scope.kind === 'default') return Object.freeze([]);
    if (scope.kind === 'one') return Object.freeze([scope.organizationId]);
    if (scope.kind === 'selected') return Object.freeze([...new Set(scope.organizationIds)]);
    return this.repository.listActiveOrganizationIds();
  }

  private async requireVersion(moduleId: string, version: number): Promise<ModuleVersion> {
    const found = await this.repository.getVersion(moduleId, version);
    if (!found) throw new Error('Module version was not found.');
    return found;
  }

  private requireModule(id: string): PlatformModule {
    const found = this.modules(id);
    if (!found) throw new Error('Platform platformModule was not found.');
    return found;
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

async function validateCurrentAiManifest(manifest: AiConfigManifestV1): Promise<void> {
  const providers = new ProviderRegistry();
  for (const profile of manifest.models) providers.assertProfileSupported(profile, profile.purpose);
  assertExecutable(manifest, await captureRuntimeIdentity());
}

function validateOverridePaths(paths: readonly string[]): readonly string[] {
  if (!Array.isArray(paths)) throw new Error('Override policy must be an array of exact JSON-pointer paths.');
  const unique = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith('/') || path.includes('*')) throw new Error('Override policy paths must be exact JSON pointers.');
    if (unique.has(path)) throw new Error('Override policy paths must be unique.');
    unique.add(path);
  }
  return Object.freeze([...unique].sort());
}

function isOperationKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(value);
}
