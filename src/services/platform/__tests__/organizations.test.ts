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

import { getWorkOS } from '@workos-inc/authkit-nextjs';
import type { WorkosAccountsClient, WorkosMember } from '../../tenant-accounts';
import {
  createWorkosOrganizationsClient,
  PlatformOrganizationAdminService,
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

class FakeAccounts implements WorkosAccountsClient {
  memberships = new Map<string, { role: 'admin' | 'member'; status: 'active' | 'inactive' }>();
  failActivate = false;
  async ensureUser(email: string) { return { id: `user_${email.split('@')[0]}` }; }
  async listMemberships(): Promise<WorkosMember[]> {
    return [...this.memberships].map(([id, m]) => ({ workosUserId: id, email: `${id}@x.pe`, createdAt: '', ...m }));
  }
  async activateMembership(_org: string, userId: string, roleSlug: 'admin' | 'member') {
    if (this.failActivate) throw new Error('workos down');
    const current = this.memberships.get(userId);
    if (!current) { this.memberships.set(userId, { role: roleSlug, status: 'active' }); return 'created' as const; }
    if (roleSlug === 'admin' && current.role !== 'admin') { current.role = 'admin'; return 'upgraded' as const; }
    return 'already_active' as const;
  }
  async deactivateMembership() {}
  async revokeSessions() {}
}

describe('D52 organization first admin', () => {
  const adminInput = { tenantId: 'tenant-1', workosOrgId: 'org_1', email: 'Jefe@Ejemplo.pe', actorWorkosUserId: 'user-super', reason: 'Alta' };
  beforeEach(() => { mocks.audit.record.mockReset(); mocks.audit.record.mockResolvedValue(undefined); });

  it('create + provision gives the first admin the admin role and audits success', async () => {
    const accounts = new FakeAccounts();
    const res = await new PlatformOrganizationAdminService(accounts).provision(adminInput);
    expect(res).toMatchObject({ ok: true, code: 'provisioned' });
    expect(accounts.memberships.get('user_jefe')).toEqual({ role: 'admin', status: 'active' });
    expect(mocks.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'organization.admin_provision', outcome: 'success', scopeId: 'tenant-1' }));
  });

  it('a failure reports it, audits failure, and a retry is idempotent', async () => {
    const accounts = new FakeAccounts();
    const service = new PlatformOrganizationAdminService(accounts);
    accounts.failActivate = true;
    expect(await service.provision(adminInput)).toMatchObject({ ok: false, code: 'failed' });
    expect(mocks.audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failure' }));
    accounts.failActivate = false;
    expect(await service.provision(adminInput)).toMatchObject({ ok: true, code: 'provisioned' });
    expect(await service.provision(adminInput)).toMatchObject({ ok: true, code: 'already_admin' });
    expect(accounts.memberships.size).toBe(1);
  });

  it('upgrades an existing member to admin', async () => {
    const accounts = new FakeAccounts();
    accounts.memberships.set('user_jefe', { role: 'member', status: 'active' });
    expect(await new PlatformOrganizationAdminService(accounts).provision(adminInput)).toMatchObject({ ok: true, code: 'provisioned' });
    expect(accounts.memberships.get('user_jefe')!.role).toBe('admin');
  });

  it('rejects an invalid email without touching WorkOS and lists only active admins', async () => {
    const accounts = new FakeAccounts();
    const service = new PlatformOrganizationAdminService(accounts);
    expect(await service.provision({ ...adminInput, email: 'nope' })).toMatchObject({ ok: false, code: 'invalid_email' });
    accounts.memberships.set('a', { role: 'admin', status: 'active' });
    accounts.memberships.set('b', { role: 'admin', status: 'inactive' });
    accounts.memberships.set('c', { role: 'member', status: 'active' });
    expect((await service.listAdmins('org_1')).map((m) => m.workosUserId)).toEqual(['a']);
  });
});

describe('WorkOS organizations client findByExternalId', () => {
  it('maps a 404 to undefined so create proceeds, and rethrows other errors', async () => {
    const get = vi.fn().mockRejectedValueOnce(Object.assign(new Error('nf'), { status: 404 }));
    vi.mocked(getWorkOS).mockReturnValue({ organizations: { getOrganizationByExternalId: get } } as never);
    const client = createWorkosOrganizationsClient();
    expect(await client.findByExternalId('op-1')).toBeUndefined();
    get.mockResolvedValueOnce({ id: 'org_1', externalId: 'op-1' });
    expect(await client.findByExternalId('op-1')).toEqual({ id: 'org_1', externalId: 'op-1' });
    get.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(client.findByExternalId('op-1')).rejects.toThrow('boom');
  });
});
