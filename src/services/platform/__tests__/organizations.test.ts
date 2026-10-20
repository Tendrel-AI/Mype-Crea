import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  organizations: {
    createPending: vi.fn(),
    attachWorkosOrganization: vi.fn(),
    failOperation: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    setStatus: vi.fn(),
  },
  audit: { record: vi.fn() },
}));

vi.mock('../../../repos/global', () => ({ globalRepos: () => mocks }));
vi.mock('@workos-inc/authkit-nextjs', () => ({ getWorkOS: vi.fn() }));

import {
  PlatformOrganizationService,
  type WorkosOrganization,
  type WorkosOrganizationsClient,
} from '../organizations';

class FakeWorkosOrganizations implements WorkosOrganizationsClient {
  readonly organizations = new Map<string, WorkosOrganization>();
  readonly findByExternalId = vi.fn(async (externalId: string) =>
    [...this.organizations.values()].find((organization) => organization.externalId === externalId));
  readonly create = vi.fn(async (input: { name: string; externalId: string }) => {
    const organization = { id: `workos-${this.organizations.size + 1}`, externalId: input.externalId };
    this.organizations.set(organization.id, organization);
    return organization;
  });
  readonly update = vi.fn(async ({ id }: { id: string; name: string }) => {
    const organization = this.organizations.get(id);
    if (!organization) throw new Error('missing organization');
    return organization;
  });
}

const input = { operationKey: 'operation-1', name: 'Example', actorWorkosUserId: 'user-super', reason: 'Support request' };

function setup() {
  const workos = new FakeWorkosOrganizations();
  const service = new PlatformOrganizationService(workos);
  return { service, workos };
}

describe('platform organization lifecycle', () => {
  beforeEach(() => {
    for (const repository of Object.values(mocks)) {
      for (const method of Object.values(repository)) method.mockReset();
    }
    mocks.organizations.createPending.mockResolvedValue({ tenantId: 'tenant-1', created: true });
    mocks.organizations.attachWorkosOrganization.mockResolvedValue('tenant-1');
    mocks.organizations.failOperation.mockResolvedValue(undefined);
    mocks.audit.record.mockResolvedValue(undefined);
  });

  it('retries an identical create using WorkOS externalId reconciliation without creating twice', async () => {
    const { service, workos } = setup();
    const first = await service.create(input);
    const replay = await service.create(input);

    expect(first).toEqual({ tenantId: 'tenant-1', workosOrgId: 'workos-1' });
    expect(replay).toEqual(first);
    expect(mocks.organizations.createPending).toHaveBeenCalledTimes(2);
    expect(workos.create).toHaveBeenCalledTimes(1);
    expect(workos.findByExternalId).toHaveBeenNthCalledWith(2, input.operationKey);
    expect(mocks.organizations.attachWorkosOrganization).toHaveBeenCalledTimes(2);
    expect(mocks.organizations.failOperation).not.toHaveBeenCalled();
  });

  it('marks a WorkOS failure for reconciliation and retries by finding the created organization', async () => {
    const { service, workos } = setup();
    const createError = Object.assign(new Error('temporary WorkOS error'), { code: 'workos_unavailable' });
    workos.create.mockRejectedValueOnce(createError);

    await expect(service.create(input)).rejects.toBe(createError);
    expect(mocks.organizations.failOperation).toHaveBeenCalledWith({
      operationKey: input.operationKey, errorCode: 'workos_unavailable',
      actorWorkosUserId: input.actorWorkosUserId, reason: input.reason,
    });

    workos.organizations.set('workos-existing', { id: 'workos-existing', externalId: input.operationKey });
    await expect(service.create(input)).resolves.toEqual({ tenantId: 'tenant-1', workosOrgId: 'workos-existing' });
    expect(workos.create).toHaveBeenCalledTimes(1);
  });

  it('records reconciliation when WorkOS succeeds but the local organization attach fails', async () => {
    const { service } = setup();
    const attachError = new Error('local transaction failed');
    mocks.organizations.attachWorkosOrganization.mockRejectedValueOnce(attachError);

    await expect(service.create(input)).rejects.toBe(attachError);
    expect(mocks.organizations.failOperation).toHaveBeenCalledWith({
      operationKey: input.operationKey, errorCode: 'unknown',
      actorWorkosUserId: input.actorWorkosUserId, reason: input.reason,
    });
  });

  it('compensates WorkOS when the local rename fails and audits the partial failure', async () => {
    const { service, workos } = setup();
    mocks.organizations.getById.mockResolvedValue({ tenantId: 'tenant-1', workosOrgId: 'workos-1', name: 'Old name' });
    mocks.organizations.update.mockRejectedValue(new Error('database unavailable'));
    workos.organizations.set('workos-1', { id: 'workos-1', externalId: input.operationKey });

    await expect(service.rename({ tenantId: 'tenant-1', name: 'New name', actorWorkosUserId: 'user-super', reason: 'Rename' }))
      .rejects.toThrow('database unavailable');

    expect(workos.update).toHaveBeenNthCalledWith(1, { id: 'workos-1', name: 'New name' });
    expect(workos.update).toHaveBeenNthCalledWith(2, { id: 'workos-1', name: 'Old name' });
    expect(mocks.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: { error: 'unknown', compensation: 'succeeded' },
    }));
  });

  it('treats a disappeared local organization as a failed rename and restores the WorkOS name', async () => {
    const { service, workos } = setup();
    mocks.organizations.getById.mockResolvedValue({ tenantId: 'tenant-1', workosOrgId: 'workos-1', name: 'Old name' });
    mocks.organizations.update.mockResolvedValue(undefined);
    workos.organizations.set('workos-1', { id: 'workos-1', externalId: input.operationKey });

    await expect(service.rename({ tenantId: 'tenant-1', name: 'New name', actorWorkosUserId: 'user-super', reason: 'Rename' }))
      .rejects.toThrow('Organization was not found');
    expect(workos.update).toHaveBeenNthCalledWith(2, { id: 'workos-1', name: 'Old name' });
  });

  it('audits when WorkOS rename compensation also fails without hiding the database error', async () => {
    const { service, workos } = setup();
    mocks.organizations.getById.mockResolvedValue({ tenantId: 'tenant-1', workosOrgId: 'workos-1', name: 'Old name' });
    mocks.organizations.update.mockRejectedValue(new Error('database unavailable'));
    workos.organizations.set('workos-1', { id: 'workos-1', externalId: input.operationKey });
    workos.update.mockResolvedValueOnce({ id: 'workos-1' }).mockRejectedValueOnce(Object.assign(new Error('rollback failed'), { code: 'rollback_failed' }));

    await expect(service.rename({ tenantId: 'tenant-1', name: 'New name', actorWorkosUserId: 'user-super', reason: 'Rename' }))
      .rejects.toThrow('database unavailable');
    expect(mocks.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      metadata: { error: 'unknown', compensation: 'failed', compensationError: 'rollback_failed' },
    }));
  });
});
