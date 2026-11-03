/**
 * KAN-41 (SYS-06) tenant account management against a disposable PostgreSQL database, through
 * the real `TenantAccountService` + `tenantAccountsRepo` as app_user, with a fake WorkOS client.
 * Proves the goal flow (provision → listed → deactivate → identity fails closed → reactivate,
 * one audit row each), every refusal changing nothing, the concurrent last-admin race, and the
 * grants/RLS on `users` and `tenant_account_audit_events`. DATABASE_URL (owner) only seeds and
 * inspects. Refuses to run unless both URLs point at the same database ending in _ci or _test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { withTenantTransaction } from '../../db/with-transaction';
import { repos, systemRepos, type Tenant, type User } from '..';
import { NotTenantAdminError } from '../tenant-accounts';
import { TenantAccountService, type WorkosAccountsClient } from '../../services/tenant-accounts';

vi.mock('@workos-inc/authkit-nextjs', () => ({ getWorkOS: vi.fn(() => { throw new Error('real WorkOS must not be called'); }) }));

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) {
    throw new Error('Tenant account integration tests require one disposable database ending in _ci or _test');
  }
  if (owner.hostname !== app.hostname || owner.port !== app.port) throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  if (owner.username === 'app_user' || app.username !== 'app_user') {
    throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
  }
}

class FakeWorkos implements WorkosAccountsClient {
  users = new Map<string, string>();
  memberships = new Map<string, 'active' | 'inactive'>();
  calls = 0;
  async ensureUser(email: string) {
    this.calls++;
    if (!this.users.has(email)) this.users.set(email, `user_${randomUUID().replace(/-/g, '')}`);
    return { id: this.users.get(email)! };
  }
  async activateMembership(org: string, userId: string) { this.calls++; this.memberships.set(`${org}:${userId}`, 'active'); }
  async deactivateMembership(org: string, userId: string) { this.calls++; this.memberships.set(`${org}:${userId}`, 'inactive'); }
}

interface Fixture { tenant: Tenant; org: string; admin: User; member: User }

SUITE('KAN-41 tenant accounts (integration)', () => {
  let owner: pg.Client;

  async function createTenant(): Promise<Fixture> {
    const tenantId = randomUUID();
    const org = `org_KAN41${randomUUID().replace(/-/g, '')}`;
    await owner.query(`INSERT INTO tenants (id, kind, name, workos_org_id) VALUES ($1, 'institutional', $2, $3)`, [tenantId, `KAN-41 ${tenantId}`, org]);
    const mk = async (role: 'admin' | 'member'): Promise<User> => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
        [id, tenantId, `user_${id.replace(/-/g, '')}`, `${id}@example.invalid`, role],
      );
      return { id };
    };
    return { tenant: { id: tenantId }, org, admin: await mk('admin'), member: await mk('member') };
  }

  const service = (f: Fixture, actor: User, workos: WorkosAccountsClient) =>
    ({ svc: new TenantAccountService(repos(f.tenant, actor).tenantAccounts, workos), actor: { tenant: f.tenant, user: actor, organizationId: f.org } });

  const usersOf = async (tenantId: string) =>
    (await owner.query(`SELECT id, role, status FROM users WHERE tenant_id = $1 ORDER BY id`, [tenantId])).rows;
  const auditOf = async (tenantId: string) =>
    (await owner.query(`SELECT action, target_user_id, before_status, after_status, outcome, outcome_code FROM tenant_account_audit_events WHERE tenant_id = $1 ORDER BY created_at, id`, [tenantId])).rows;
  const workosIdOf = async (userId: string) =>
    (await owner.query<{ workos_user_id: string }>(`SELECT workos_user_id FROM users WHERE id = $1`, [userId])).rows[0].workos_user_id;
  const sqlState = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: { code?: string }) => error.code ?? String(error));

  beforeAll(async () => {
    assertDisposableTarget(process.env.DATABASE_URL!, process.env.APP_DATABASE_URL!);
    owner = new pg.Client({ connectionString: process.env.DATABASE_URL! });
    await owner.connect();
    const role = await owner.query<{ rolbypassrls: boolean }>(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_user'`);
    if (role.rows[0]?.rolbypassrls !== false) throw new Error('app_user must exist without BYPASSRLS');
    const who = await getPool().query<{ current_user: string }>('SELECT current_user');
    if (who.rows[0]?.current_user !== 'app_user') throw new Error('APP_DATABASE_URL must be app_user');
  });

  afterAll(async () => {
    if (owner) await owner.end();
    await closePool();
  });

  it('schema: status CHECK, users writes narrowed, audit append-only with RLS forced', async () => {
    const p = (await owner.query(
      `SELECT has_table_privilege('app_user', 'users', 'DELETE') AS users_del,
              has_column_privilege('app_user', 'users', 'role', 'UPDATE') AS role_upd,
              has_column_privilege('app_user', 'users', 'tenant_id', 'UPDATE') AS tenant_upd,
              has_column_privilege('app_user', 'users', 'status', 'UPDATE') AS status_upd,
              has_column_privilege('app_user', 'users', 'id', 'INSERT') AS id_ins,
              has_table_privilege('app_user', 'tenant_account_audit_events', 'SELECT') AS audit_sel,
              has_table_privilege('app_user', 'tenant_account_audit_events', 'UPDATE') AS audit_upd,
              has_table_privilege('app_user', 'tenant_account_audit_events', 'DELETE') AS audit_del,
              has_column_privilege('app_user', 'tenant_account_audit_events', 'created_at', 'INSERT') AS audit_ts`,
    )).rows[0];
    expect(p).toEqual({ users_del: false, role_upd: false, tenant_upd: false, status_upd: true, id_ins: false, audit_sel: true, audit_upd: false, audit_del: false, audit_ts: false });
    const rls = await owner.query(`SELECT relforcerowsecurity FROM pg_class WHERE relname = 'tenant_account_audit_events'`);
    expect(rls.rows[0].relforcerowsecurity).toBe(true);
    const f = await createTenant();
    await expect(owner.query(`UPDATE users SET status = 'paused' WHERE id = $1`, [f.member.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('goal: provision → listed → deactivate (identity fails closed) → reactivate, one audit row per step', async () => {
    const f = await createTenant();
    const workos = new FakeWorkos();
    const { svc, actor } = service(f, f.admin, workos);
    const identity = systemRepos(f.tenant).identity!;

    expect(await svc.provision(actor, { email: 'Ana@Ejemplo.pe', reason: 'Piloto' })).toMatchObject({ ok: true, code: 'provisioned' });
    const listed = await repos(f.tenant, f.admin).tenantAccounts.listMembers();
    const ana = listed.find((m) => m.email === 'ana@ejemplo.pe')!;
    expect(ana).toMatchObject({ role: 'member', status: 'active', workosUserId: workos.users.get('ana@ejemplo.pe') });
    expect(await identity.resolveMember(f.org, ana.workosUserId)).toEqual({ userId: ana.id, role: 'member' });
    expect(await svc.provision(actor, { email: 'ana@ejemplo.pe' })).toMatchObject({ ok: true, code: 'already_active' });

    expect(await svc.deactivate(actor, { userId: ana.id })).toEqual({ ok: true, code: 'deactivated', message: 'Desactivaste la cuenta de ana@ejemplo.pe. Sus conversaciones se conservan.' });
    expect(await identity.resolveMember(f.org, ana.workosUserId)).toBeUndefined();
    expect(workos.memberships.get(`${f.org}:${ana.workosUserId}`)).toBe('inactive');

    expect(await svc.reactivate(actor, { userId: ana.id })).toMatchObject({ ok: true, code: 'reactivated' });
    expect(await identity.resolveMember(f.org, ana.workosUserId)).toEqual({ userId: ana.id, role: 'member' });
    expect(workos.memberships.get(`${f.org}:${ana.workosUserId}`)).toBe('active');

    expect(await auditOf(f.tenant.id)).toEqual([
      { action: 'member.provision', target_user_id: ana.id, before_status: null, after_status: 'active', outcome: 'success', outcome_code: null },
      { action: 'member.deactivate', target_user_id: ana.id, before_status: 'active', after_status: 'inactive', outcome: 'success', outcome_code: null },
      { action: 'member.reactivate', target_user_id: ana.id, before_status: 'inactive', after_status: 'active', outcome: 'success', outcome_code: null },
    ]);
  });

  it('a member is refused on every operation and nothing changes', async () => {
    const f = await createTenant();
    const before = await usersOf(f.tenant.id);
    const repo = repos(f.tenant, f.member).tenantAccounts;
    for (const call of [
      () => repo.listMembers(),
      () => repo.listAudit(),
      () => repo.addMember({ workosUserId: 'user_x', email: 'x@ejemplo.pe', reason: null }),
      () => repo.setStatus({ targetUserId: f.admin.id, status: 'inactive', reason: null }),
      () => repo.recordAudit({ action: 'member.deactivate', targetUserId: null, targetEmail: null, beforeStatus: null, afterStatus: null, reason: null, outcome: 'refused', outcomeCode: 'x' }),
    ]) await expect(call()).rejects.toBeInstanceOf(NotTenantAdminError);
    expect(await usersOf(f.tenant.id)).toEqual(before);
    expect(await auditOf(f.tenant.id)).toEqual([]);
  });

  it('an admin targeting another tenant\'s user is refused (audited), and the other tenant is untouched', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const workos = new FakeWorkos();
    const { svc, actor } = service(a, a.admin, workos);
    const beforeB = await usersOf(b.tenant.id);
    expect(await svc.deactivate(actor, { userId: b.member.id })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await svc.reactivate(actor, { userId: b.member.id })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await svc.deactivate(actor, { userId: b.admin.id })).toMatchObject({ ok: false, code: 'not_found' });
    expect(workos.calls).toBe(0);
    expect(await usersOf(b.tenant.id)).toEqual(beforeB);
    expect((await auditOf(a.tenant.id)).map((r) => [r.outcome, r.outcome_code, r.target_user_id])).toEqual([
      ['refused', 'not_found', b.member.id], ['refused', 'not_found', b.member.id], ['refused', 'not_found', b.admin.id],
    ]);
    expect(await auditOf(b.tenant.id)).toEqual([]);
    expect(await repos(b.tenant, b.admin).tenantAccounts.listAudit()).toEqual([]);
  });

  it('self-deactivation and removing the last admin are refused, audited, and change nothing', async () => {
    const f = await createTenant();
    const { svc, actor } = service(f, f.admin, new FakeWorkos());
    const before = await usersOf(f.tenant.id);
    expect(await svc.deactivate(actor, { userId: f.admin.id })).toMatchObject({ ok: false, code: 'self_deactivation' });
    // Below the service guard: the repository refuses the last active admin on its own.
    expect(await repos(f.tenant, f.admin).tenantAccounts.setStatus({ targetUserId: f.admin.id, status: 'inactive', reason: null }))
      .toEqual({ kind: 'refused', code: 'last_admin' });
    expect(await usersOf(f.tenant.id)).toEqual(before);
    expect((await auditOf(f.tenant.id)).map((r) => [r.outcome, r.outcome_code])).toEqual([['refused', 'self_deactivation'], ['refused', 'last_admin']]);
  });

  it('two admins deactivating each other concurrently leave exactly one active admin', async () => {
    const f = await createTenant();
    const second = { id: randomUUID() };
    await owner.query(
      `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, 'admin', 'active')`,
      [second.id, f.tenant.id, `user_${second.id.replace(/-/g, '')}`, `${second.id}@example.invalid`],
    );
    // Hold both admin rows so the two transactions start before either can finish.
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL! });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) FOR UPDATE', [[f.admin.id, second.id]]);
    const pending = Promise.allSettled([
      repos(f.tenant, f.admin).tenantAccounts.setStatus({ targetUserId: second.id, status: 'inactive', reason: null }),
      repos(f.tenant, second).tenantAccounts.setStatus({ targetUserId: f.admin.id, status: 'inactive', reason: null }),
    ]);
    for (let waiting = 0; waiting < 2;) {
      waiting = (await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'app_user' AND wait_event_type = 'Lock'`,
      )).rows[0].n;
    }
    await holder.query('COMMIT');
    await holder.end();
    const results = await pending;
    expect(results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'changed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof NotTenantAdminError)).toHaveLength(1);
    const admins = (await usersOf(f.tenant.id)).filter((u) => u.role === 'admin' && u.status === 'active');
    expect(admins).toHaveLength(1);
  });

  it('RLS and grants: no role change, no admin insert, no delete, no member writes, audit append-only', async () => {
    const f = await createTenant();
    const other = await createTenant();
    const asUser = (user: User, sql: string, params: unknown[] = []) => withTenantTransaction(f.tenant, user, (tx) => tx.query(sql, params));
    expect(await sqlState(asUser(f.admin, `UPDATE users SET role = 'admin' WHERE id = $1`, [f.member.id]))).toBe('42501');
    expect(await sqlState(asUser(f.admin, `DELETE FROM users WHERE id = $1`, [f.member.id]))).toBe('42501');
    expect(await sqlState(asUser(f.admin,
      `INSERT INTO users (tenant_id, workos_user_id, email, role, status) VALUES ($1, 'user_forged', 'f@ejemplo.pe', 'admin', 'active')`, [f.tenant.id]))).toBe('42501');
    expect(await sqlState(asUser(f.admin,
      `INSERT INTO users (tenant_id, workos_user_id, email, role, status) VALUES ($1, 'user_forged', 'f@ejemplo.pe', 'member', 'active')`, [other.tenant.id]))).toBe('42501');
    expect(await sqlState(asUser(f.member,
      `INSERT INTO users (tenant_id, workos_user_id, email, role, status) VALUES ($1, 'user_forged', 'f@ejemplo.pe', 'member', 'active')`, [f.tenant.id]))).toBe('42501');
    // A member's UPDATE matches no row under RLS; nothing changes.
    await asUser(f.member, `UPDATE users SET status = 'inactive' WHERE id = $1`, [f.admin.id]);
    // A cross-tenant UPDATE from an admin also matches nothing.
    await asUser(f.admin, `UPDATE users SET status = 'inactive' WHERE id = $1`, [other.member.id]);
    expect((await usersOf(f.tenant.id)).every((u) => u.status === 'active')).toBe(true);
    expect((await usersOf(other.tenant.id)).every((u) => u.status === 'active')).toBe(true);

    await repos(f.tenant, f.admin).tenantAccounts.recordAudit({ action: 'member.deactivate', targetUserId: null, targetEmail: null, beforeStatus: null, afterStatus: null, reason: null, outcome: 'refused', outcomeCode: 'not_found' });
    expect(await sqlState(asUser(f.admin, `UPDATE tenant_account_audit_events SET outcome = 'success'`))).toBe('42501');
    expect(await sqlState(asUser(f.admin, `DELETE FROM tenant_account_audit_events`))).toBe('42501');
    expect((await asUser(f.member, `SELECT * FROM tenant_account_audit_events`)).rowCount).toBe(0);
    expect(await sqlState(asUser(f.member,
      `INSERT INTO tenant_account_audit_events (tenant_id, actor_user_id, action, outcome) VALUES ($1, $2, 'member.provision', 'success')`, [f.tenant.id, f.member.id]))).toBe('42501');
    expect(await sqlState(asUser(f.admin,
      `INSERT INTO tenant_account_audit_events (tenant_id, actor_user_id, action, outcome) VALUES ($1, $2, 'member.provision', 'success')`, [f.tenant.id, f.member.id]))).toBe('42501');
    expect((await asUser(f.admin, `SELECT * FROM tenant_account_audit_events`)).rowCount).toBe(1);
  });

  it('a WorkOS-side failure on deactivation keeps access off and a repeat re-syncs', async () => {
    const f = await createTenant();
    const workos = new FakeWorkos();
    let fail = true;
    const flaky: WorkosAccountsClient = { ...workos, ensureUser: (e) => workos.ensureUser(e), activateMembership: (o, u) => workos.activateMembership(o, u),
      deactivateMembership: async (o, u) => { if (fail) { fail = false; throw new Error('workos down'); } return workos.deactivateMembership(o, u); } };
    const { svc, actor } = service(f, f.admin, flaky);
    const wos = await workosIdOf(f.member.id);
    expect(await svc.deactivate(actor, { userId: f.member.id })).toMatchObject({ ok: true, code: 'deactivated' });
    expect(await systemRepos(f.tenant).identity!.resolveMember(f.org, wos)).toBeUndefined();
    expect(await svc.deactivate(actor, { userId: f.member.id })).toMatchObject({ ok: true, code: 'already_inactive' });
    expect(workos.memberships.get(`${f.org}:${wos}`)).toBe('inactive');
    expect((await auditOf(f.tenant.id)).map((r) => [r.outcome, r.outcome_code])).toEqual([['success', null], ['failed', 'workos_sync_failed']]);
  });
});
