import { describe, expect, it, vi } from 'vitest';
import type { ResolvedIdentity } from '../../../auth/resolve-identity';
import { createBaselineDraft } from '../baseline';
import { AiAdminService } from '../admin-service';
import { AiConfigService } from '../service';

const asIdentity = (tenantRole: 'admin' | 'member', platformAdmin = false) => ({
  tenant: { id: 'tenant-a' }, user: { id: 'user-a' }, tenantRole,
  workosUserId: 'user_abc', organizationId: 'org_abc', platformAdmin,
}) as unknown as ResolvedIdentity;

function service() {
  const repository: any = {
    createDraft: vi.fn(),
    listSharedReleases: vi.fn(async () => []),
    getRelease: vi.fn(async () => undefined),
    updateDraft: vi.fn(),
    setProviderAvailability: vi.fn(),
    listProviderAvailability: vi.fn(),
  };
  return { service: new AiConfigService(() => repository as never, async () => {}), repository };
}

describe('AiConfigService authorization', () => {
  it('rejects a tenant administrator trying to create arbitrary unbased content', async () => {
    const { service: api, repository } = service();
    await expect(api.createDraft(asIdentity('admin'), { name: 'forged', manifest: {} })).rejects.toThrow(/Platform administration/);
    expect(repository.createDraft).not.toHaveBeenCalled();
  });

  it('rejects a tenant administrator importing content without an approved shared base', async () => {
    const { service: api, repository } = service();
    await expect(api.importDraft(asIdentity('admin'), { name: 'forged', serialized: '{}' })).rejects.toThrow(/Platform administration/);
    expect(repository.createDraft).not.toHaveBeenCalled();
  });

  it('does not let members read or change provider availability', async () => {
    const { service: api, repository } = service();
    await expect(api.listProviderAvailability(asIdentity('member'))).rejects.toThrow(/Tenant administration/);
    await expect(api.setProviderAvailability(asIdentity('member'), { provider: 'openrouter', enabled: false, expectedVersion: 0 })).rejects.toThrow(/Tenant administration/);
    expect(repository.listProviderAvailability).not.toHaveBeenCalled();
    expect(repository.setProviderAvailability).not.toHaveBeenCalled();
  });

  it('rejects a tenant change outside the exact shared override whitelist', async () => {
    const { service: api, repository } = service();
    const manifest = await createBaselineDraft();
    const shared = { id: 'shared-a', name: 'Shared', status: 'frozen' as const, draftVersion: 1, manifest, contentHash: 'a'.repeat(64), allowedOverridePaths: [] };
    repository.listSharedReleases.mockResolvedValue([shared]);
    repository.getRelease.mockResolvedValue({
      id: 'draft-a', tenantId: 'tenant-a', name: 'Draft', status: 'draft', draftVersion: 1, manifest,
      contentHash: null, baseSharedReleaseId: shared.id, allowedOverridePaths: [],
    });
    const changed = structuredClone(manifest);
    (changed.planner as { version: string }).version = 'planner.changed';

    await expect(api.updateDraft(asIdentity('admin'), { releaseId: 'draft-a', expectedVersion: 1, manifest: changed }))
      .rejects.toThrow(/override path is not permitted/);
    expect(repository.updateDraft).not.toHaveBeenCalled();
  });

  it('requires a platform identity to publish shared releases even when tenant admin', async () => {
    const { service: api, repository } = service();
    await expect(api.createSharedDraft(asIdentity('admin'), { name: 'Shared', manifest: {}, allowedOverridePaths: [] }))
      .rejects.toThrow(/Platform administration/);
    expect(repository.createDraft).not.toHaveBeenCalled();
  });

  it('blocks tenant members from querying or exporting admin traces', async () => {
    const repository = { adminGetTurn: vi.fn(), adminListTurns: vi.fn(), adminListAttempts: vi.fn(), adminListNotices: vi.fn(), adminGetUsage: vi.fn(), adminDeleteTraceContent: vi.fn() };
    const admin = new AiAdminService(() => repository as never);
    await expect(admin.listTurns(asIdentity('member'))).rejects.toThrow(/No tienes permiso/);
    await expect(admin.exportTurnTrace(asIdentity('member'), 'turn-forged')).rejects.toThrow(/No tienes permiso/);
    expect(repository.adminListTurns).not.toHaveBeenCalled();
    expect(repository.adminGetTurn).not.toHaveBeenCalled();
  });
});
