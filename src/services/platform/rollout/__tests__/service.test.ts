import { describe, expect, it, vi } from 'vitest';
import { aiPlatformModule } from '../../modules/ai';
import { listPlatformModules } from '../../modules/registry';
import { ModuleRolloutService, type EffectiveModuleVersion, type ModuleRolloutRepository, type ModuleVersion, type OrganizationRolloutResult, type RolloutOperation } from '../service';
import { createBaselineDraft } from '../../../ai-config/baseline';

const RELEASE_A = '00000000-0000-4000-8000-000000000001';
const RELEASE_B = '00000000-0000-4000-8000-000000000002';

class FakeRolloutRepository implements ModuleRolloutRepository {
  readonly versions: ModuleVersion[] = [];
  readonly assignments = new Map<string, number>();
  readonly results = new Map<string, OrganizationRolloutResult>();
  readonly operations = new Map<string, RolloutOperation>();
  defaultVersion: number | null = null;
  orgs = ['org-1', 'org-2', 'org-3'];
  failOrgOnce: string | undefined;

  async listActiveOrganizationIds() { return this.orgs; }
  async getVersion(moduleId: string, version: number) { return this.versions.find((item) => item.moduleId === moduleId && item.version === version); }
  async listVersions(moduleId: string) { return this.versions.filter((item) => item.moduleId === moduleId); }
  async createVersion(input: { moduleId: string; config: unknown; actorWorkosUserId: string }) {
    const prior = this.versions.filter((item) => item.moduleId === input.moduleId).at(-1);
    const version = { moduleId: input.moduleId, config: input.config, createdByWorkosUserId: input.actorWorkosUserId,
      version: (prior?.version ?? 0) + 1, createdAt: '2026-01-01T00:00:00.000Z', previousVersion: prior?.version ?? null };
    this.versions.push(version);
    return version;
  }
  async publishAiVersion(input: Parameters<ModuleRolloutRepository['publishAiVersion']>[0]) {
    const version = await this.createVersion({ moduleId: 'ai', config: { sharedReleaseId: RELEASE_A }, actorWorkosUserId: input.actorWorkosUserId });
    return { version, sharedReleaseId: RELEASE_A };
  }
  async getCurrentVersion(_moduleId: string, organizationId: string) { return this.assignments.get(organizationId) ?? null; }
  async getEffectiveVersion(_moduleId: string, organizationId: string, _actorWorkosUserId: string): Promise<EffectiveModuleVersion> {
    const version = this.assignments.get(organizationId);
    return version === undefined ? { source: 'unconfigured', moduleVersion: null, releaseId: null }
      : { source: 'organization_assignment', moduleVersion: version, releaseId: RELEASE_A };
  }
  async getDefaultVersion() { return this.defaultVersion; }
  async getOperation(operationKey: string) { return this.operations.get(operationKey); }
  async listOperationsForOrganization(organizationId: string) {
    return [...this.operations.values()].filter((operation) => operation.organizationIds.includes(organizationId));
  }
  async beginOperation(input: Parameters<ModuleRolloutRepository['beginOperation']>[0]) {
    const operation: RolloutOperation = { operationKey: input.operationKey, moduleId: input.moduleId, scope: input.scope,
      organizationIds: input.organizationIds, version: input.version, status: 'pending', results: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    this.operations.set(input.operationKey, operation);
    return operation;
  }
  async applyOrganization(input: Parameters<ModuleRolloutRepository['applyOrganization']>[0]) {
    if (this.failOrgOnce === input.organizationId) {
      this.failOrgOnce = undefined;
      const failed = { organizationId: input.organizationId, status: 'failed' as const,
        previousVersion: this.assignments.get(input.organizationId) ?? null, version: input.version, error: 'retry me' };
      this.saveResult(input.operationKey, failed);
      return failed;
    }
    const previousVersion = this.assignments.get(input.organizationId) ?? null;
    this.assignments.set(input.organizationId, input.version);
    const result = { organizationId: input.organizationId, status: 'succeeded' as const, previousVersion, version: input.version };
    this.saveResult(input.operationKey, result);
    return result;
  }
  async setDefault(input: Parameters<ModuleRolloutRepository['setDefault']>[0]) { this.defaultVersion = input.version; }
  async recordOrganizationFailure(input: Parameters<ModuleRolloutRepository['recordOrganizationFailure']>[0]) {
    const result = { organizationId: input.organizationId, status: 'failed' as const,
      previousVersion: this.assignments.get(input.organizationId) ?? null, version: input.version, error: input.error };
    this.saveResult(input.operationKey, result);
    return result;
  }
  async finishOperation(operationKey: string, status: RolloutOperation['status'], _actorWorkosUserId: string) {
    const operation = this.operations.get(operationKey)!;
    const next = { ...operation, status };
    this.operations.set(operationKey, next);
    return next;
  }
  private saveResult(operationKey: string, result: OrganizationRolloutResult) {
    this.results.set(`${operationKey}:${result.organizationId}`, result);
    const operation = this.operations.get(operationKey);
    if (operation) {
      this.operations.set(operationKey, { ...operation,
        results: [...operation.results.filter((item) => item.organizationId !== result.organizationId), result] });
    }
  }
}

function setup() {
  const repository = new FakeRolloutRepository();
  const authorize = vi.fn(async (actor: string) => { if (actor !== 'user_super') throw new Error('denied'); });
  const checkConfig = vi.fn(async ({ config, organizationId }: { moduleId: string; config: unknown; organizationId?: string }) => { void organizationId; aiPlatformModule.validateConfig(config); });
  const service = new ModuleRolloutService((id) => id === 'ai' ? aiPlatformModule : undefined, repository, authorize, checkConfig, async () => {});
  return { service, repository, authorize, checkConfig };
}

describe('platform module rollout', () => {
  it('discovers the AI module through the registry', () => {
    expect(listPlatformModules().map((module) => module.id)).toEqual(['ai']);
  });

  it('publishes a validated frozen AI behavior as a shared release and module version without tenant identity', async () => {
    const { service, repository } = setup();
    const result = await service.publishAiModuleVersion({ actorWorkosUserId: 'user_super', name: 'AI release',
      manifest: await createBaselineDraft(), allowedOverridePaths: [], operationKey: 'publication-0001', reason: 'Initial rollout.' });

    expect(result).toMatchObject({ sharedReleaseId: RELEASE_A, moduleVersion: { moduleId: 'ai', version: 1,
      createdByWorkosUserId: 'user_super', config: { sharedReleaseId: RELEASE_A } } });
    expect(repository.versions).toHaveLength(1);
  });

  it('validates immutable versions and previews target organizations before applying', async () => {
    const { service, repository, checkConfig } = setup();
    const version = await service.publishVersion({ actorWorkosUserId: 'user_super', moduleId: 'ai', config: { sharedReleaseId: RELEASE_A } });
    const preview = await service.preview({ actorWorkosUserId: 'user_super', moduleId: 'ai', version: version.version, scope: { kind: 'selected', organizationIds: ['org-1', 'org-3'] } });

    expect(repository.versions).toHaveLength(1);
    expect(preview.organizations).toEqual([
      { organizationId: 'org-1', currentVersion: null, effectiveVersion: { source: 'unconfigured', moduleVersion: null, releaseId: null }, compatible: true },
      { organizationId: 'org-3', currentVersion: null, effectiveVersion: { source: 'unconfigured', moduleVersion: null, releaseId: null }, compatible: true },
    ]);
    expect(checkConfig).toHaveBeenCalledTimes(3);
  });

  it('sets a default for future organizations and applies selected scopes with retry-safe per-org outcomes', async () => {
    const { service, repository } = setup();
    const first = await service.publishVersion({ actorWorkosUserId: 'user_super', moduleId: 'ai', config: { sharedReleaseId: RELEASE_A } });
    const second = await service.publishVersion({ actorWorkosUserId: 'user_super', moduleId: 'ai', config: { sharedReleaseId: RELEASE_B } });
    await service.apply({ actorWorkosUserId: 'user_super', moduleId: 'ai', version: first.version, scope: { kind: 'default' }, operationKey: 'default-1' });
    repository.failOrgOnce = 'org-2';
    const partial = await service.apply({ actorWorkosUserId: 'user_super', moduleId: 'ai', version: second.version, scope: { kind: 'selected', organizationIds: ['org-1', 'org-2'] }, operationKey: 'apply-1' });
    const retried = await service.retry({ actorWorkosUserId: 'user_super', operationKey: 'apply-1' });

    expect(repository.defaultVersion).toBe(first.version);
    expect(partial.status).toBe('partial');
    expect(retried.status).toBe('complete');
    expect(repository.assignments.get('org-1')).toBe(second.version);
    expect(repository.assignments.get('org-2')).toBe(second.version);
    expect(repository.assignments.has('org-3')).toBe(false);
  });

  it('records incompatible organizations as failed and continues compatible targets', async () => {
    const { service, repository, checkConfig } = setup();
    const version = await service.publishVersion({ actorWorkosUserId: 'user_super', moduleId: 'ai', config: { sharedReleaseId: RELEASE_A } });
    checkConfig.mockImplementation(async ({ organizationId }: { moduleId: string; config: unknown; organizationId?: string }) => {
      if (organizationId === 'org-2') throw new Error('inactive');
    });
    const result = await service.apply({ actorWorkosUserId: 'user_super', moduleId: 'ai', version: version.version,
      scope: { kind: 'selected', organizationIds: ['org-1', 'org-2'] }, operationKey: 'apply-incompatible' });

    expect(result.status).toBe('partial');
    expect(repository.assignments.get('org-1')).toBe(version.version);
    expect(repository.assignments.has('org-2')).toBe(false);
    expect(result.results.find((item) => item.organizationId === 'org-2')).toMatchObject({ status: 'failed' });
  });

  it('rolls back by reapplying a previous immutable version and denies an unauthorized actor', async () => {
    const { service, repository } = setup();
    const first = await service.publishVersion({ actorWorkosUserId: 'user_super', moduleId: 'ai', config: { sharedReleaseId: RELEASE_A } });
    const second = await service.publishVersion({ actorWorkosUserId: 'user_super', moduleId: 'ai', config: { sharedReleaseId: RELEASE_B } });
    await service.apply({ actorWorkosUserId: 'user_super', moduleId: 'ai', version: second.version, scope: { kind: 'one', organizationId: 'org-1' }, operationKey: 'apply-2' });
    const rollback = await service.rollback({ actorWorkosUserId: 'user_super', moduleId: 'ai', targetVersion: first.version,
      scope: { kind: 'one', organizationId: 'org-1' }, operationKey: 'rollback-1', reason: 'Restore prior release.' });

    expect(rollback.status).toBe('complete');
    expect(repository.assignments.get('org-1')).toBe(first.version);
    await expect(service.preview({ actorWorkosUserId: 'user_other', moduleId: 'ai', version: second.version, scope: { kind: 'all' } })).rejects.toThrow('denied');
    expect(repository.versions.map((version) => version.version)).toEqual([1, 2]);
  });
});
