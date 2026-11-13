/**
 * KAN-41 / D52 `TenantAccountService` over an in-memory repo and a fake WorkOS client: WorkOS-only
 * provisioning, deactivation order (local block, then WorkOS, then sessions), partial failures
 * keeping the block, and guards computed from WorkOS memberships.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AccountAuditEntry, AccountRole, AccountStatus, TenantAccountsRepo } from '../../repos/tenant-accounts';
import { TenantAccountService, type ActivateOutcome, type WorkosAccountsClient, type WorkosMember } from '../tenant-accounts';

// The real WorkOS client is never constructed: every test injects FakeWorkos.
vi.mock('@workos-inc/authkit-nextjs', () => ({ getWorkOS: vi.fn(() => { throw new Error('real WorkOS must not be called') }) }));

const ORG = 'org_KAN41';
const events: string[] = [];

class FakeRepo implements TenantAccountsRepo {
  /** Local mirror rows by workos user id. */
  mirror = new Map<string, { id: string; status: AccountStatus }>();
  audit: AccountAuditEntry[] = [];
  async setMirrorStatus({ workosUserId, status }: { workosUserId: string; status: AccountStatus }) {
    events.push(`local:${status}`);
    const row = this.mirror.get(workosUserId);
    if (!row) return undefined;
    row.status = status;
    return { userId: row.id };
  }
  async recordAudit(entry: AccountAuditEntry) { this.audit.push(entry); }
  async listAudit() { return []; }
}

class FakeWorkos implements WorkosAccountsClient {
  members = new Map<string, WorkosMember>();
  calls: string[] = [];
  failOn: string | undefined;
  private step(name: string) {
    this.calls.push(name);
    events.push(`workos:${name}`);
    if (this.failOn === name) throw new Error('workos down');
  }
  seed(id: string, role: AccountRole, status: AccountStatus = 'active', email = `${id}@ejemplo.pe`) {
    this.members.set(id, { workosUserId: id, email, role, status, createdAt: '2026-11-13T00:00:00.000Z' });
  }
  async ensureUser(email: string) {
    this.step('ensureUser');
    const found = [...this.members.values()].find((m) => m.email === email);
    return { id: found?.workosUserId ?? `user_${email.split('@')[0].replace(/\W/g, '')}` };
  }
  async listMemberships() { return [...this.members.values()]; }
  async activateMembership(_org: string, userId: string, roleSlug: AccountRole): Promise<ActivateOutcome> {
    this.step('activate');
    const current = this.members.get(userId);
    if (current?.status === 'active') return 'already_active';
    this.members.set(userId, { ...(current ?? { workosUserId: userId, email: `${userId}@ejemplo.pe`, createdAt: '' }), role: current?.role ?? roleSlug, status: 'active' });
    return current ? 'reactivated' : 'created';
  }
  async deactivateMembership(_org: string, userId: string) {
    this.step('deactivate');
    const current = this.members.get(userId)!;
    this.members.set(userId, { ...current, status: 'inactive' });
  }
  async revokeSessions() { this.step('revokeSessions'); }
}

function setup() {
  events.length = 0;
  const repo = new FakeRepo();
  const workos = new FakeWorkos();
  workos.seed('user_admin', 'admin');
  workos.seed('user_admin2', 'admin');
  workos.seed('user_ana', 'member');
  const actor = { tenant: { id: 't1' }, user: { id: 'u1' }, workosUserId: 'user_admin', organizationId: ORG } as never;
  return { repo, workos, actor, service: new TenantAccountService(repo, workos) };
}

describe('provision', () => {
  it('is WorkOS-only: ensures user and member membership, audits, and never inserts a local row', async () => {
    const { service, repo, workos, actor } = setup();
    const res = await service.provision(actor, { email: ' Nuevo@Ejemplo.pe ', reason: 'Piloto' });
    expect(res).toMatchObject({ ok: true, code: 'provisioned' });
    expect(workos.calls).toEqual(['ensureUser', 'activate']);
    expect(repo.mirror.size).toBe(0);
    expect(repo.audit).toEqual([expect.objectContaining({ action: 'member.provision', targetEmail: 'nuevo@ejemplo.pe', outcome: 'success', outcomeCode: null })]);
  });

  it('rejects an invalid email before touching WorkOS', async () => {
    const { service, workos, actor } = setup();
    expect(await service.provision(actor, { email: 'nope' })).toMatchObject({ ok: false, code: 'invalid_email' });
    expect(workos.calls).toEqual([]);
  });

  it('reports already active without auditing or writing locally', async () => {
    const { service, repo, actor } = setup();
    expect(await service.provision(actor, { email: 'user_ana@ejemplo.pe' })).toMatchObject({ ok: true, code: 'already_active' });
    expect(repo.audit).toEqual([]);
    expect(events).not.toContain('local:active');
  });

  it('reactivates an inactive membership and lifts the local block', async () => {
    const { service, repo, workos, actor } = setup();
    workos.seed('user_old', 'member', 'inactive');
    repo.mirror.set('user_old', { id: 'u-old', status: 'inactive' });
    expect(await service.provision(actor, { email: 'user_old@ejemplo.pe' })).toMatchObject({ ok: true, code: 'provisioned' });
    expect(repo.mirror.get('user_old')!.status).toBe('active');
    expect(repo.audit[0]).toMatchObject({ targetUserId: 'u-old', beforeStatus: 'inactive', afterStatus: 'active' });
  });

  it('a WorkOS failure is audited and reported without a local write', async () => {
    const { service, repo, workos, actor } = setup();
    workos.failOn = 'activate';
    expect(await service.provision(actor, { email: 'x@ejemplo.pe' })).toMatchObject({ ok: false, code: 'failed' });
    expect(repo.audit).toEqual([expect.objectContaining({ outcome: 'failed', outcomeCode: 'workos_failed' })]);
  });
});

describe('deactivate', () => {
  it('runs local inactive, then WorkOS, then session revocation', async () => {
    const { service, repo, workos, actor } = setup();
    repo.mirror.set('user_ana', { id: 'u-ana', status: 'active' });
    expect(await service.deactivate(actor, { workosUserId: 'user_ana' })).toMatchObject({ ok: true, code: 'deactivated' });
    expect(events).toEqual(['local:inactive', 'workos:deactivate', 'workos:revokeSessions']);
    expect(workos.members.get('user_ana')!.status).toBe('inactive');
    expect(repo.audit).toEqual([expect.objectContaining({ action: 'member.deactivate', targetUserId: 'u-ana', outcome: 'success' })]);
  });

  it('a person who never signed in (no local row) is still deactivated in WorkOS', async () => {
    const { service, workos, actor } = setup();
    expect(await service.deactivate(actor, { workosUserId: 'user_ana' })).toMatchObject({ ok: true, code: 'deactivated' });
    expect(workos.calls).toEqual(['deactivate', 'revokeSessions']);
  });

  it('a WorkOS failure keeps the local block, audits, and a repeat re-syncs', async () => {
    const { service, repo, workos, actor } = setup();
    repo.mirror.set('user_ana', { id: 'u-ana', status: 'active' });
    workos.failOn = 'deactivate';
    const first = await service.deactivate(actor, { workosUserId: 'user_ana' });
    expect(first).toMatchObject({ ok: true, code: 'deactivated' });
    expect(first.message).toContain('ya está bloqueado');
    expect(repo.mirror.get('user_ana')!.status).toBe('inactive');
    expect(repo.audit).toEqual([expect.objectContaining({ outcome: 'failed', outcomeCode: 'workos_sync_failed' })]);
    workos.failOn = undefined;
    expect(await service.deactivate(actor, { workosUserId: 'user_ana' })).toMatchObject({ ok: true, code: 'deactivated' });
    expect(workos.members.get('user_ana')!.status).toBe('inactive');
  });

  it('a session revocation failure also keeps the block and is reported', async () => {
    const { service, repo, workos, actor } = setup();
    repo.mirror.set('user_ana', { id: 'u-ana', status: 'active' });
    workos.failOn = 'revokeSessions';
    expect((await service.deactivate(actor, { workosUserId: 'user_ana' })).message).toContain('ya está bloqueado');
    expect(repo.mirror.get('user_ana')!.status).toBe('inactive');
  });

  it('refuses self-deactivation, computed from the WorkOS user id, before any write', async () => {
    const { service, repo, workos, actor } = setup();
    expect(await service.deactivate(actor, { workosUserId: 'user_admin' })).toMatchObject({ ok: false, code: 'self_deactivation' });
    expect(events).toEqual([]);
    expect(workos.members.get('user_admin')!.status).toBe('active');
    expect(repo.audit[0]).toMatchObject({ outcome: 'refused', outcomeCode: 'self_deactivation' });
  });

  it('refuses the last active admin (from WorkOS memberships) but allows it when another admin is active', async () => {
    const { service, workos, actor } = setup();
    expect(await service.deactivate(actor, { workosUserId: 'user_admin2' })).toMatchObject({ ok: true, code: 'deactivated' });
    const other = { ...(actor as object), workosUserId: 'user_ana' } as never;
    expect(await service.deactivate(other, { workosUserId: 'user_admin' })).toMatchObject({ ok: false, code: 'last_admin' });
    expect(workos.members.get('user_admin')!.status).toBe('active');
  });

  it('an id that is not a member of this organization is refused and never reaches WorkOS writes', async () => {
    const { service, repo, workos, actor } = setup();
    expect(await service.deactivate(actor, { workosUserId: 'user_foreign' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await service.deactivate(actor, { workosUserId: 'not-an-id' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(workos.calls).toEqual([]);
    expect(repo.audit.map((a) => a.outcomeCode)).toEqual(['not_found', 'not_found']);
  });
});

describe('reactivate', () => {
  it('WorkOS first, then the local mirror', async () => {
    const { service, repo, workos, actor } = setup();
    workos.seed('user_old', 'member', 'inactive');
    repo.mirror.set('user_old', { id: 'u-old', status: 'inactive' });
    expect(await service.reactivate(actor, { workosUserId: 'user_old' })).toMatchObject({ ok: true, code: 'reactivated' });
    expect(events).toEqual(['workos:activate', 'local:active']);
  });

  it('a WorkOS failure leaves the local block in place', async () => {
    const { service, repo, workos, actor } = setup();
    workos.seed('user_old', 'member', 'inactive');
    repo.mirror.set('user_old', { id: 'u-old', status: 'inactive' });
    workos.failOn = 'activate';
    expect(await service.reactivate(actor, { workosUserId: 'user_old' })).toMatchObject({ ok: false, code: 'failed' });
    expect(repo.mirror.get('user_old')!.status).toBe('inactive');
  });
});
