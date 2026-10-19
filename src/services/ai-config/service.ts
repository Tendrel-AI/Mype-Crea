import type { ResolvedIdentity } from '../../auth/resolve-identity';
import { randomUUID } from 'node:crypto';
import { captureRuntimeIdentity, createBaselineDraft as captureBaseline } from './baseline';
import { assertExecutable } from './execution';
import { ProviderRegistry } from './provider-registry';
import { diffManifests, exportManifest, freezeManifest, importManifest, validateManifest, type AiConfigManifestV1, type ManifestDiffEntry, type ProviderId } from './manifest';

export type ReleaseStatus = 'draft' | 'frozen' | 'retired';

export interface TenantReleaseRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly status: ReleaseStatus;
  readonly draftVersion: number;
  readonly manifest: AiConfigManifestV1;
  readonly contentHash: string | null;
  readonly baseSharedReleaseId: string | null;
  readonly allowedOverridePaths: readonly string[];
}

export interface SharedReleaseRecord {
  readonly id: string;
  readonly name: string;
  readonly status: ReleaseStatus;
  readonly draftVersion: number;
  readonly manifest: AiConfigManifestV1;
  readonly contentHash: string | null;
  readonly allowedOverridePaths: readonly string[];
}

export interface ProviderAvailabilityRecord {
  readonly provider: ProviderId;
  readonly enabled: boolean;
  readonly version: number;
}

export interface AiConfigRepository {
  createDraft(input: { name: string; manifest: AiConfigManifestV1; baseSharedReleaseId?: string }): Promise<TenantReleaseRecord>;
  updateDraft(input: { releaseId: string; expectedVersion: number; name?: string; manifest: AiConfigManifestV1 }): Promise<TenantReleaseRecord>;
  freezeDraft(input: { releaseId: string; expectedVersion: number }): Promise<TenantReleaseRecord>;
  retireRelease(input: { releaseId: string; expectedVersion: number }): Promise<TenantReleaseRecord>;
  getRelease(releaseId: string): Promise<TenantReleaseRecord | undefined>;
  listReleases(): Promise<readonly TenantReleaseRecord[]>;
  listSharedReleases(): Promise<readonly SharedReleaseRecord[]>;
  createSharedDraft(input: { name: string; manifest: AiConfigManifestV1; allowedOverridePaths: readonly string[] }): Promise<SharedReleaseRecord>;
  updateSharedDraft(input: { releaseId: string; expectedVersion: number; name?: string; manifest: AiConfigManifestV1; allowedOverridePaths?: readonly string[] }): Promise<SharedReleaseRecord>;
  getSharedRelease(releaseId: string): Promise<SharedReleaseRecord | undefined>;
  freezeSharedDraft(input: { releaseId: string; expectedVersion: number }): Promise<SharedReleaseRecord>;
  retireSharedRelease(input: { releaseId: string; expectedVersion: number }): Promise<SharedReleaseRecord>;
  activate(input: { releaseId: string; expectedActivationVersion: number }): Promise<unknown>;
  activateShared(input: { sharedReleaseId: string; expectedSharedVersion: number; expectedActivationVersion: number }): Promise<unknown>;
  getProviderAvailability(provider: ProviderId): Promise<ProviderAvailabilityRecord>;
  listProviderAvailability(): Promise<readonly ProviderAvailabilityRecord[]>;
  setProviderAvailability(input: { provider: ProviderId; enabled: boolean; expectedVersion: number }): Promise<ProviderAvailabilityRecord>;
  recordSyncEvent(input: { operationId: string; destination: 'git' | 'langsmith'; action: 'export' | 'prompt_publish' | 'prompt_import' | 'retry'; status: 'started' | 'succeeded' | 'failed'; contentHash?: string; pinnedCommit?: string; safeErrorCategory?: string; parentOperationId?: string }): Promise<void>;
  listSyncEvents(input?: { limit?: number }): Promise<readonly { readonly metadata: SyncOperationEvent; readonly occurredAt: string }[]>;
}

export interface SyncOperationEvent {
  readonly operationId: string;
  readonly destination: 'git' | 'langsmith';
  readonly action: 'export' | 'prompt_publish' | 'prompt_import' | 'retry';
  readonly status: 'started' | 'succeeded' | 'failed';
  readonly contentHash?: string;
  readonly pinnedCommit?: string;
  readonly safeErrorCategory?: string;
  readonly parentOperationId?: string;
  readonly createdAt?: string;
}

export type AiConfigRepositoryFactory = (identity: ResolvedIdentity) => AiConfigRepository;

/** Authorized application service. The repository repeats every permission check transactionally. */
export class AiConfigService {
  constructor(
    private readonly repositoryFor: AiConfigRepositoryFactory,
    private readonly validateForExecution: (manifest: AiConfigManifestV1) => Promise<void> = validateCurrentExecutable,
  ) {}

  async listReleases(identity: ResolvedIdentity): Promise<readonly TenantReleaseRecord[]> {
    requireAdmin(identity);
    return this.repositoryFor(identity).listReleases();
  }

  async listSharedReleases(identity: ResolvedIdentity): Promise<readonly SharedReleaseRecord[]> {
    requireAdmin(identity);
    return this.repositoryFor(identity).listSharedReleases();
  }

  async createDraft(identity: ResolvedIdentity, input: { name: string; manifest: unknown }): Promise<TenantReleaseRecord> {
    requirePlatformAdmin(identity);
    const manifest = validateManifest(input.manifest);
    await this.assertExecutable(manifest);
    return this.repositoryFor(identity).createDraft({ name: input.name, manifest });
  }

  async createSharedBaselineDraft(identity: ResolvedIdentity, name: string): Promise<SharedReleaseRecord> {
    requirePlatformAdmin(identity);
    const manifest = await captureBaseline();
    await this.assertExecutable(manifest);
    return this.repositoryFor(identity).createSharedDraft({ name, manifest, allowedOverridePaths: [] });
  }

  async importDraft(identity: ResolvedIdentity, input: { name: string; serialized: string; baseSharedReleaseId?: string }): Promise<TenantReleaseRecord> {
    if (input.baseSharedReleaseId) {
      requireTenantAdmin(identity);
      const imported = importManifest(input.serialized).content;
      await this.assertExecutable(imported);
      const repository = this.repositoryFor(identity);
      const base = (await repository.listSharedReleases()).find((item) => item.id === input.baseSharedReleaseId && item.status === 'frozen');
      if (!base) throw new Error('Frozen shared base was not found.');
      await this.assertManifestOverrideAllowed(repository, base, imported);
      return repository.createDraft({ name: input.name, manifest: imported, baseSharedReleaseId: base.id });
    }
    requirePlatformAdmin(identity);
    const imported = importManifest(input.serialized).content;
    await this.assertExecutable(imported);
    return this.repositoryFor(identity).createDraft({ name: input.name, manifest: imported });
  }

  async createOverrideDraft(identity: ResolvedIdentity, input: { sharedReleaseId: string; name: string }): Promise<TenantReleaseRecord> {
    requireTenantAdmin(identity);
    const shared = (await this.repositoryFor(identity).listSharedReleases()).find((release) => release.id === input.sharedReleaseId);
    if (!shared || shared.status !== 'frozen') throw new Error('Shared frozen release was not found.');
    return this.repositoryFor(identity).createDraft({ name: input.name, manifest: shared.manifest, baseSharedReleaseId: shared.id });
  }

  async updateDraft(identity: ResolvedIdentity, input: { releaseId: string; expectedVersion: number; name?: string; manifest: unknown }): Promise<TenantReleaseRecord> {
    requireTenantAdmin(identity);
    const repository = this.repositoryFor(identity);
    const existing = await repository.getRelease(input.releaseId);
    if (!existing || existing.status !== 'draft') throw new Error('Editable draft was not found.');
    const manifest = validateManifest(input.manifest);
    await this.assertOverrideAllowed(repository, existing, manifest);
    await this.assertExecutable(manifest);
    return repository.updateDraft({ releaseId: existing.id, expectedVersion: input.expectedVersion, name: input.name, manifest });
  }

  async validateDraft(identity: ResolvedIdentity, releaseId: string): Promise<{ readonly manifest: AiConfigManifestV1; readonly contentHash: string }> {
    requireAdmin(identity);
    const release = await this.repositoryFor(identity).getRelease(releaseId);
    if (!release) throw new Error('Release was not found.');
    const frozen = freezeManifest(release.manifest);
    await this.assertExecutable(frozen.content);
    return Object.freeze({ manifest: frozen.content, contentHash: frozen.contentHash });
  }

  async diffDraft(identity: ResolvedIdentity, releaseId: string): Promise<readonly ManifestDiffEntry[]> {
    requireAdmin(identity);
    const repository = this.repositoryFor(identity);
    const release = await repository.getRelease(releaseId);
    if (!release) throw new Error('Release was not found.');
    if (!release.baseSharedReleaseId) return Object.freeze([]);
    const shared = (await repository.listSharedReleases()).find((candidate) => candidate.id === release.baseSharedReleaseId);
    if (!shared) throw new Error('Shared release lineage was not found.');
    return diffManifests(shared.manifest, release.manifest);
  }

  async validateSharedDraft(identity: ResolvedIdentity, releaseId: string): Promise<{ readonly manifest: AiConfigManifestV1; readonly contentHash: string }> {
    requirePlatformAdmin(identity);
    const release = await this.repositoryFor(identity).getSharedRelease(releaseId);
    if (!release || release.status !== 'draft') throw new Error('Shared draft was not found.');
    const frozen = freezeManifest(release.manifest);
    await this.assertExecutable(frozen.content);
    return Object.freeze({ manifest: frozen.content, contentHash: frozen.contentHash });
  }

  async diffSharedDraft(identity: ResolvedIdentity, input: { releaseId: string; manifest: unknown }): Promise<readonly ManifestDiffEntry[]> {
    requirePlatformAdmin(identity);
    const release = await this.repositoryFor(identity).getSharedRelease(input.releaseId);
    if (!release || release.status !== 'draft') throw new Error('Shared draft was not found.');
    const candidate = validateManifest(input.manifest);
    await this.assertExecutable(candidate);
    return diffManifests(release.manifest, candidate);
  }

  async freezeDraft(identity: ResolvedIdentity, input: { releaseId: string; expectedVersion: number }): Promise<TenantReleaseRecord> {
    requireTenantAdmin(identity);
    const repository = this.repositoryFor(identity);
    const release = await repository.getRelease(input.releaseId);
    if (!release || release.status !== 'draft') throw new Error('Editable draft was not found.');
    await this.assertOverrideAllowed(repository, release, validateManifest(release.manifest));
    await this.assertExecutable(release.manifest);
    return repository.freezeDraft(input);
  }

  async activate(identity: ResolvedIdentity, input: { releaseId: string; expectedActivationVersion: number }): Promise<unknown> {
    requireTenantAdmin(identity);
    const release = await this.repositoryFor(identity).getRelease(input.releaseId);
    if (!release || release.status !== 'frozen') throw new Error('Only a frozen tenant release can be activated.');
    await this.assertExecutable(release.manifest);
    return this.repositoryFor(identity).activate(input);
  }

  async activateShared(identity: ResolvedIdentity, input: { sharedReleaseId: string; expectedSharedVersion: number; expectedActivationVersion: number }): Promise<unknown> {
    requireTenantAdmin(identity);
    const shared = (await this.repositoryFor(identity).listSharedReleases()).find((release) => release.id === input.sharedReleaseId);
    if (!shared || shared.status !== 'frozen' || shared.draftVersion !== input.expectedSharedVersion) {
      throw new Error('Expected shared frozen release was not found.');
    }
    await this.assertExecutable(shared.manifest);
    return this.repositoryFor(identity).activateShared(input);
  }

  async retireRelease(identity: ResolvedIdentity, input: { releaseId: string; expectedVersion: number }): Promise<TenantReleaseRecord> {
    requireTenantAdmin(identity);
    return this.repositoryFor(identity).retireRelease(input);
  }

  async createSharedDraft(identity: ResolvedIdentity, input: { name: string; manifest: unknown; allowedOverridePaths: readonly string[] }): Promise<SharedReleaseRecord> {
    requirePlatformAdmin(identity);
    const paths = validateOverridePaths(input.allowedOverridePaths);
    const manifest = validateManifest(input.manifest);
    await this.assertExecutable(manifest);
    return this.repositoryFor(identity).createSharedDraft({ name: input.name, manifest, allowedOverridePaths: paths });
  }

  async updateSharedDraft(identity: ResolvedIdentity, input: { releaseId: string; expectedVersion: number; name?: string; manifest: unknown; allowedOverridePaths?: readonly string[] }): Promise<SharedReleaseRecord> {
    requirePlatformAdmin(identity);
    const allowedOverridePaths = input.allowedOverridePaths === undefined ? undefined : validateOverridePaths(input.allowedOverridePaths);
    const manifest = validateManifest(input.manifest);
    await this.assertExecutable(manifest);
    return this.repositoryFor(identity).updateSharedDraft({ ...input, manifest, allowedOverridePaths });
  }

  async freezeSharedDraft(identity: ResolvedIdentity, input: { releaseId: string; expectedVersion: number }): Promise<SharedReleaseRecord> {
    requirePlatformAdmin(identity);
    const release = await this.repositoryFor(identity).getSharedRelease(input.releaseId);
    if (!release || release.status !== 'draft') throw new Error('Shared draft was not found.');
    await this.assertExecutable(release.manifest);
    return this.repositoryFor(identity).freezeSharedDraft(input);
  }

  async retireSharedRelease(identity: ResolvedIdentity, input: { releaseId: string; expectedVersion: number }): Promise<SharedReleaseRecord> {
    requirePlatformAdmin(identity);
    return this.repositoryFor(identity).retireSharedRelease(input);
  }

  async exportRelease(identity: ResolvedIdentity, releaseId: string): Promise<string> {
    requireAdmin(identity);
    const release = await this.repositoryFor(identity).getRelease(releaseId);
    if (!release) throw new Error('Release was not found.');
    const content = exportManifest(release.manifest);
    await this.repositoryFor(identity).recordSyncEvent({ operationId: randomUUID(), destination: 'git', action: 'export', status: 'succeeded', contentHash: freezeManifest(release.manifest).contentHash });
    return content;
  }

  async exportSharedRelease(identity: ResolvedIdentity, releaseId: string): Promise<string> {
    requirePlatformAdmin(identity);
    const release = (await this.repositoryFor(identity).listSharedReleases()).find((candidate) => candidate.id === releaseId);
    if (!release) throw new Error('Shared release was not found.');
    const content = exportManifest(release.manifest);
    await this.repositoryFor(identity).recordSyncEvent({ operationId: randomUUID(), destination: 'git', action: 'export', status: 'succeeded', contentHash: freezeManifest(release.manifest).contentHash });
    return content;
  }

  async listSyncEvents(identity: ResolvedIdentity, limit = 50): Promise<readonly SyncOperationEvent[]> {
    requireAdmin(identity);
    const rows = await this.repositoryFor(identity).listSyncEvents({ limit });
    return rows.map(({ metadata, occurredAt }) => Object.freeze({ ...metadata, createdAt: occurredAt }));
  }

  async listProviderAvailability(identity: ResolvedIdentity): Promise<readonly ProviderAvailabilityRecord[]> {
    requireTenantAdmin(identity);
    return this.repositoryFor(identity).listProviderAvailability();
  }

  async setProviderAvailability(identity: ResolvedIdentity, input: { provider: ProviderId; enabled: boolean; expectedVersion: number }): Promise<ProviderAvailabilityRecord> {
    requireTenantAdmin(identity);
    return this.repositoryFor(identity).setProviderAvailability(input);
  }

  private async assertOverrideAllowed(repository: AiConfigRepository, release: TenantReleaseRecord, candidate: AiConfigManifestV1): Promise<void> {
    if (!release.baseSharedReleaseId) return;
    const shared = (await repository.listSharedReleases()).find((item) => item.id === release.baseSharedReleaseId);
    if (!shared) throw new Error('Shared release lineage was not found.');
    await this.assertManifestOverrideAllowed(repository, shared, candidate);
  }

  private async assertManifestOverrideAllowed(repository: AiConfigRepository, shared: SharedReleaseRecord, candidate: AiConfigManifestV1): Promise<void> {
    const changed = diffManifests(shared.manifest, candidate);
    const denied = changed.find((entry) => !shared.allowedOverridePaths.includes(entry.path));
    if (denied) throw new Error(`Tenant override path is not permitted: ${denied.path}`);
  }

  private async assertExecutable(manifest: AiConfigManifestV1): Promise<void> {
    await this.validateForExecution(manifest);
  }
}

async function validateCurrentExecutable(manifest: AiConfigManifestV1): Promise<void> {
  const validator = new ProviderRegistry();
  for (const profile of manifest.models) validator.assertProfileSupported(profile, profile.purpose);
  const identity = await captureRuntimeIdentity();
  assertExecutable(manifest, identity);
}

function requireAdmin(identity: ResolvedIdentity): void {
  if (identity.tenantRole !== 'admin' && !identity.platformAdmin) {
    throw new Error('Configuration administration is not authorized.');
  }
}

function requireTenantAdmin(identity: ResolvedIdentity): void {
  if (identity.tenantRole !== 'admin') throw new Error('Tenant administration is not authorized.');
}

function requirePlatformAdmin(identity: ResolvedIdentity): void {
  if (!identity.platformAdmin) throw new Error('Platform administration is not authorized.');
}

function validateOverridePaths(paths: readonly string[]): readonly string[] {
  if (!Array.isArray(paths)) throw new Error('Override policy must be an array of exact JSON-pointer paths.');
  const unique = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith('/') || path.includes('*') || path.includes('**')) throw new Error('Override policy paths must be exact JSON pointers.');
    if (unique.has(path)) throw new Error('Override policy paths must be unique.');
    unique.add(path);
  }
  return Object.freeze([...unique].sort());
}
