/**
 * KAN-41 `TenantAccountService` over an in-memory tenant repo and a fake WorkOS client:
 * the happy path (one audit row per step), every refusal changing nothing, WorkOS ordering per
 * operation, and the partial-failure rules (provision retry converges, deactivation is local-first).
 */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AccountAuditEntry, AccountStatus, SetStatusResult, TenantAccountsRepo, TenantMember } from '../../repos/tenant-accounts';
import { TenantAccountService, type WorkosAccountsClient } from '../tenant-accounts';

// The real WorkOS client is never constructed: every test injects FakeWorkos.
vi.mock('@workos-inc/authkit-nextjs', () => ({ getWorkOS: vi.fn(() => { throw new Error('real WorkOS must not be called'); }) }));

const ORG = 'org_KAN41';

class FakeRepo implements TenantAccountsRepo {
  members = new Map<string, TenantMember>();
  audit: AccountAuditEntry[] = [];
  failAdd = false;

  seed(role: 'admin' | 'member', status: AccountStatus = 'active', email = `${randomUUID()}@ejemplo.pe`): TenantMember {
    const member: TenantMember = { id: randomUUID(), workosUserId: `user_${randomUUID().replace(/-/g, '')}`, email, role, status, createdAt: new Date().toISOString() };
    this.members.set(member.id, member);
    return member;
  }
  async listMembers() { return [...this.members.values()]; }
  async findMember(id: string) { return this.members.get(id); }
  async findByEmail(email: string) { return [...this.members.values()].find((m) => m.email === email); }
  async addMember(input: { workosUserId: string; email: string; reason: string | null }) {
    if (this.failAdd) throw new Error('db down');
    const existing = await this.findByEmail(input.email);
    if (existing) return { member: existing, created: false };
    const member: TenantMember = { id: randomUUID(), workosUserId: input.workosUserId, email: input.email, role: 'member', status: 'active', createdAt: new Date().toISOString() };
    this.members.set(member.id, member);
    this.audit.push({ action: 'member.provision', targetUserId: member.id, targetEmail: member.email, beforeStatus: null, afterStatus: 'active', reason: input.reason, outcome: 'success', outcomeCode: null });
    return { member, created: true };
  }
  async setStatus(input: { targetUserId: string; status: AccountStatus; reason: string | null }): Promise<SetStatusResult> {
    const action = input.status === 'inactive' ? 'member.deactivate' as const : 'member.reactivate' as const;
    const target = this.members.get(input.targetUserId);
    if (!target) {
      this.audit.push({ action, targetUserId: input.targetUserId, targetEmail: null, beforeStatus: null, afterStatus: null, reason: input.reason, outcome: 'refused', outcomeCode: 'not_found' });
      return { kind: 'refused', code: 'not_found' };
    }
    if (target.status === input.status) return { kind: 'unchanged', member: target };
    const admins = [...this.members.values()].filter((m) => m.role === 'admin' && m.status === 'active');
    if (input.status === 'inactive' && target.role === 'admin' && admins.length <= 1) {
      this.audit.push({ action, targetUserId: target.id, targetEmail: target.email, beforeStatus: target.status, afterStatus: target.status, reason: input.reason, outcome: 'refused', outcomeCode: 'last_admin' });
      return { kind: 'refused', code: 'last_admin' };
    }
    const member = { ...target, status: input.status };
    this.members.set(member.id, member);
    this.audit.push({ action, targetUserId: target.id, targetEmail: target.email, beforeStatus: target.status, afterStatus: input.status, reason: input.reason, outcome: 'success', outcomeCode: null });
    return { kind: 'changed', member, before: target.status };
  }
  async recordAudit(entry: AccountAuditEntry) { this.audit.push(entry); }
  async listAudit() { return []; }
}

class FakeWorkos implements WorkosAccountsClient {
  users = new Map<string, string>();
  memberships = new Map<string, 'active' | 'inactive'>();
  calls: string[] = [];
  failNext = false;
  private maybeFail(name: string) {
    this.calls.push(name);
    if (this.failNext) { this.failNext = false; throw new Error('workos down'); }
  }
  async ensureUser(email: string) {
    this.maybeFail('ensureUser');
    if (!this.users.has(email)) this.users.set(email, `user_${this.users.size + 1}`);
    return { id: this.users.get(email)! };
  }
  async activateMembership(org: string, userId: string) { this.maybeFail('activate'); this.memberships.set(`${org}:${userId}`, 'active'); }
  async deactivateMembership(org: string, userId: string) { this.maybeFail('deactivate'); this.memberships.set(`${org}:${userId}`, 'inactive'); }
}

function setup() {
  const repo = new FakeRepo();
  const workos = new FakeWorkos();
  const admin = repo.seed('admin');
  const actor = { tenant: { id: randomUUID() }, user: { id: admin.id }, organizationId: ORG };
  return { repo, workos, admin, actor, service: new TenantAccountService(repo, workos) };
}

describe('TenantAccountService', () => {
  it('provisions, deactivates and reactivates a member with exactly one audit row per step', async () => {
    const { repo, workos, actor, service } = setup();
    const created = await service.provision(actor, { email: '  Ana@Ejemplo.pe ', reason: 'Nueva emprendedora' });
    expect(created).toMatchObject({ ok: true, code: 'provisioned' });
    const ana = (await repo.findByEmail('ana@ejemplo.pe'))!;
    expect(ana).toMatchObject({ role: 'member', status: 'active', workosUserId: 'user_1' });
    expect(workos.memberships.get(`${ORG}:user_1`)).toBe('active');
    expect(repo.audit).toHaveLength(1);

    const off = await service.deactivate(actor, { userId: ana.id });
    expect(off).toEqual({ ok: true, code: 'deactivated', message: 'Desactivaste la cuenta de ana@ejemplo.pe. Sus conversaciones se conservan.' });
    expect(repo.members.get(ana.id)?.status).toBe('inactive');
    expect(workos.memberships.get(`${ORG}:user_1`)).toBe('inactive');
    expect(repo.audit).toHaveLength(2);

    const on = await service.reactivate(actor, { userId: ana.id });
    expect(on).toMatchObject({ ok: true, code: 'reactivated' });
    expect(repo.members.get(ana.id)?.status).toBe('active');
    expect(workos.memberships.get(`${ORG}:user_1`)).toBe('active');
    expect(repo.audit.map((row) => [row.action, row.outcome, row.beforeStatus, row.afterStatus])).toEqual([
      ['member.provision', 'success', null, 'active'],
      ['member.deactivate', 'success', 'active', 'inactive'],
      ['member.reactivate', 'success', 'inactive', 'active'],
    ]);
  });

  it('refuses self-deactivation before any DB or WorkOS change, with one refused audit row', async () => {
    const { repo, workos, admin, actor, service } = setup();
    repo.seed('admin');
    const res = await service.deactivate(actor, { userId: admin.id });
    expect(res).toEqual({ ok: false, code: 'self_deactivation', message: 'No puedes desactivar tu propia cuenta de administrador.' });
    expect(repo.members.get(admin.id)?.status).toBe('active');
    expect(workos.calls).toEqual([]);
    expect(repo.audit).toEqual([expect.objectContaining({ outcome: 'refused', outcomeCode: 'self_deactivation', targetUserId: admin.id })]);
  });

  it('refuses a foreign or forged target without touching WorkOS', async () => {
    const { repo, workos, actor, service } = setup();
    for (const userId of [randomUUID(), 'not-a-uuid', 42, "' OR 1=1 --"]) {
      expect(await service.deactivate(actor, { userId })).toMatchObject({ ok: false, code: 'not_found', message: 'No encontramos esa cuenta en tu organización.' });
      expect(await service.reactivate(actor, { userId })).toMatchObject({ ok: false, code: 'not_found' });
    }
    expect(workos.calls).toEqual([]);
    expect(repo.audit.every((row) => row.outcome === 'refused' && row.outcomeCode === 'not_found')).toBe(true);
    expect(repo.audit).toHaveLength(8);
  });

  it('passes the repository last-admin refusal through without calling WorkOS', async () => {
    const { repo, workos, actor, service } = setup();
    const other = repo.seed('admin');
    repo.members.set(actor.user.id, { ...repo.members.get(actor.user.id)!, status: 'inactive' }); // concurrent removal won
    const res = await service.deactivate(actor, { userId: other.id });
    expect(res).toMatchObject({ ok: false, code: 'last_admin', message: 'No puedes desactivar al último administrador activo de tu organización.' });
    expect(workos.calls).toEqual([]);
  });

  it('provision is idempotent and never duplicates an account', async () => {
    const { repo, workos, actor, service } = setup();
    await service.provision(actor, { email: 'ana@ejemplo.pe' });
    const again = await service.provision(actor, { email: 'ANA@ejemplo.pe' });
    expect(again).toMatchObject({ ok: true, code: 'already_active' });
    expect(workos.calls).toEqual(['ensureUser', 'activate']);
    expect([...repo.members.values()].filter((m) => m.email === 'ana@ejemplo.pe')).toHaveLength(1);
  });

  it('provision refuses invalid email or reason and an inactive account without any WorkOS call', async () => {
    const { repo, workos, actor, service } = setup();
    repo.seed('member', 'inactive', 'luis@ejemplo.pe');
    expect(await service.provision(actor, { email: 'no-es-correo' })).toMatchObject({ ok: false, code: 'invalid_email' });
    expect(await service.provision(actor, { email: { forged: true } })).toMatchObject({ ok: false, code: 'invalid_email' });
    expect(await service.provision(actor, { email: 'a@b.pe', reason: 'x'.repeat(501) })).toMatchObject({ ok: false, code: 'invalid_reason' });
    expect(await service.provision(actor, { email: 'luis@ejemplo.pe' })).toMatchObject({ ok: false, code: 'member_inactive' });
    expect(workos.calls).toEqual([]);
    expect(repo.audit).toEqual([]);
  });

  it('WorkOS failing on provision writes nothing locally and audits the failure', async () => {
    const { repo, workos, actor, service } = setup();
    workos.failNext = true;
    expect(await service.provision(actor, { email: 'ana@ejemplo.pe' })).toMatchObject({ ok: false, code: 'failed' });
    expect(await repo.findByEmail('ana@ejemplo.pe')).toBeUndefined();
    expect(repo.audit).toEqual([expect.objectContaining({ outcome: 'failed', outcomeCode: 'workos_failed', targetEmail: 'ana@ejemplo.pe' })]);
  });

  it('DB failing after WorkOS: audited failure, then a retry reuses the WorkOS user and completes', async () => {
    const { repo, workos, actor, service } = setup();
    repo.failAdd = true;
    expect(await service.provision(actor, { email: 'ana@ejemplo.pe' })).toMatchObject({ ok: false, code: 'failed' });
    expect(repo.audit).toEqual([expect.objectContaining({ outcome: 'failed', outcomeCode: 'db_failed' })]);
    repo.failAdd = false;
    expect(await service.provision(actor, { email: 'ana@ejemplo.pe' })).toMatchObject({ ok: true, code: 'provisioned' });
    expect(workos.users.size).toBe(1);
    expect((await repo.findByEmail('ana@ejemplo.pe'))?.workosUserId).toBe('user_1');
  });

  it('deactivation is local-first: a WorkOS failure keeps access off, is audited, and a repeat re-syncs', async () => {
    const { repo, workos, actor, service } = setup();
    const ana = repo.seed('member');
    workos.memberships.set(`${ORG}:${ana.workosUserId}`, 'active');
    workos.failNext = true;
    const res = await service.deactivate(actor, { userId: ana.id });
    expect(res).toMatchObject({ ok: true, code: 'deactivated' });
    expect(res.message).toContain('El acceso ya está bloqueado');
    expect(repo.members.get(ana.id)?.status).toBe('inactive');
    expect(repo.audit.map((row) => [row.outcome, row.outcomeCode])).toEqual([['success', null], ['failed', 'workos_sync_failed']]);
    expect(await service.deactivate(actor, { userId: ana.id })).toMatchObject({ ok: true, code: 'already_inactive' });
    expect(workos.memberships.get(`${ORG}:${ana.workosUserId}`)).toBe('inactive');
    expect(repo.audit).toHaveLength(2);
  });

  it('reactivation is WorkOS-first: a WorkOS failure leaves the account inactive', async () => {
    const { repo, workos, actor, service } = setup();
    const ana = repo.seed('member', 'inactive');
    workos.failNext = true;
    expect(await service.reactivate(actor, { userId: ana.id })).toMatchObject({ ok: false, code: 'failed' });
    expect(repo.members.get(ana.id)?.status).toBe('inactive');
    expect(repo.audit).toEqual([expect.objectContaining({ action: 'member.reactivate', outcome: 'failed', outcomeCode: 'workos_failed' })]);
  });

  it('copy is neutral Spanish with tú (no voseo)', async () => {
    const { repo, actor, service } = setup();
    const ana = repo.seed('member');
    const messages = [
      (await service.deactivate(actor, { userId: ana.id })).message,
      (await service.reactivate(actor, { userId: ana.id })).message,
      (await service.deactivate(actor, { userId: actor.user.id })).message,
      (await service.provision(actor, { email: 'x' })).message,
    ].join(' ');
    expect(messages).not.toMatch(/\b(vos|sos|podés|tenés|querés|desactivá|reactivá|escribí)\b/i);
  });
});
