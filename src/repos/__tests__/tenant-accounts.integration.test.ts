/**
 * KAN-41 / D52 tenant account management against a disposable PostgreSQL database, through
 * the real `TenantAccountService` + `tenantAccountsRepo` + `identityRepo` as app_user, with a
 * fake WorkOS client. Proves the goal flow (WorkOS-only provision → first sign-in mirrors the row
 * through `app.sync_member` → deactivate blocks the mirror → reactivate), the sync function's
 * rules (role sync, verified-email relink, never activating an inactive row, no cross-tenant
 * effect), and the grants/RLS on `users` and `tenant_account_audit_events`. DATABASE_URL (owner) only seeds and
 * inspects. Refuses to run unless both URLs point at the same database ending in _ci or _test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { withTenantTransaction } from '../../db/with-transaction';
import { repos, systemRepos, type Tenant, type User } from '..';
import { NotTenantAdminError } from '../tenant-accounts';
import { TenantAccountService, type WorkosAccountsClient, type WorkosMember } from '../../services/tenant-accounts';

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
  members = new Map<string, WorkosMember>();
  sessionsRevoked: string[] = [];
  async ensureUser(email: string) {
    if (!this.users.has(email)) this.users.set(email, `user_${randomUUID().replace(/-/g, '')}`);
    return { id: this.users.get(email)! };
  }
  async listMemberships() { return [...this.members.values()]; }
  async activateMembership(_org: string, userId: string, role: 'admin' | 'member') {
    const email = [...this.users].find(([, id]) => id === userId)?.[0] ?? `${userId}@ejemplo.pe`;
    const existing = this.members.get(userId);
    this.members.set(userId, { workosUserId: userId, email, role: existing?.role ?? role, status: 'active', createdAt: new Date().toISOString() });
    return existing?.status === 'active' ? 'already_active' as const : existing ? 'reactivated' as const : 'created' as const;
  }
  async deactivateMembership(_org: string, userId: string) { this.members.set(userId, { ...this.members.get(userId)!, status: 'inactive' }); }
  async revokeSessions(_org: string, userId: string) { this.sessionsRevoked.push(userId); }
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
    ({ svc: new TenantAccountService(repos(f.tenant, actor).tenantAccounts, workos), actor: { tenant: f.tenant, user: actor, workosUserId: 'user_actor', organizationId: f.org } });

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

  it('goal: WorkOS-only provision → first sign-in mirrors the row → deactivate blocks → reactivate', async () => {
    const f = await createTenant();
    const workos = new FakeWorkos();
    const { svc, actor } = service(f, f.admin, workos);
    const identity = systemRepos(f.tenant).identity!;

    expect(await svc.provision(actor, { email: 'Ana@Ejemplo.pe', reason: 'Piloto' })).toMatchObject({ ok: true, code: 'provisioned' });
    const anaId = workos.users.get('ana@ejemplo.pe')!;
    expect((await usersOf(f.tenant.id)).length).toBe(2); // no local insert at provisioning time
    expect(await identity.resolveMember(f.org, anaId)).toBeUndefined();

    const first = await identity.syncMember({ workosUserId: anaId, email: 'Ana@Ejemplo.pe', emailVerified: true, role: 'member' });
    expect(first).toMatchObject({ outcome: 'created', role: 'member', status: 'active' });
    expect(await identity.resolveMember(f.org, anaId)).toMatchObject({ userId: first!.userId, role: 'member', status: 'active' });
    expect((await owner.query(`SELECT email FROM users WHERE id = $1`, [first!.userId])).rows[0].email).toBe('ana@ejemplo.pe');

    workos.members.set('user_actor', { workosUserId: 'user_actor', email: 'a@x.pe', role: 'admin', status: 'active', createdAt: '' });
    workos.members.set('user_actor2', { workosUserId: 'user_actor2', email: 'b@x.pe', role: 'admin', status: 'active', createdAt: '' });
    expect(await svc.deactivate(actor, { workosUserId: anaId })).toMatchObject({ ok: true, code: 'deactivated' });
    expect(await identity.resolveMember(f.org, anaId)).toMatchObject({ status: 'inactive' });
    expect(workos.sessionsRevoked).toEqual([anaId]);
    // Sync never reactivates a blocked row.
    expect(await identity.syncMember({ workosUserId: anaId, email: 'ana@ejemplo.pe', emailVerified: true, role: 'admin' }))
      .toMatchObject({ outcome: 'existing', role: 'member', status: 'inactive' });

    expect(await svc.reactivate(actor, { workosUserId: anaId })).toMatchObject({ ok: true, code: 'reactivated' });
    expect(await identity.resolveMember(f.org, anaId)).toMatchObject({ status: 'active' });
    expect((await auditOf(f.tenant.id)).map((r) => [r.action, r.outcome])).toEqual([
      ['member.provision', 'success'], ['member.deactivate', 'success'], ['member.reactivate', 'success'],
    ]);
  });

  it('app.sync_member: role sync, verified-email relink, unverified refusal, inactive never relinked', async () => {
    const f = await createTenant();
    const identity = systemRepos(f.tenant).identity!;
    const memberWos = await workosIdOf(f.member.id);
    // Role sync on an active row.
    expect(await identity.syncMember({ workosUserId: memberWos, email: 'x@ejemplo.pe', emailVerified: false, role: 'admin' })).toMatchObject({ outcome: 'existing', role: 'admin', status: 'active' });
    // Relink: same tenant, verified email, new WorkOS id.
    const email = (await owner.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.member.id])).rows[0].email.toUpperCase();
    const fresh = `user_${randomUUID().replace(/-/g, '')}`;
    expect(await identity.syncMember({ workosUserId: fresh, email, emailVerified: false, role: 'member' })).toBeUndefined();
    expect(await identity.syncMember({ workosUserId: fresh, email, emailVerified: true, role: 'member' })).toMatchObject({ outcome: 'relinked', userId: f.member.id });
    expect(await identity.resolveMember(f.org, fresh)).toMatchObject({ userId: f.member.id });
    // Inactive rows are never relinked or activated.
    await owner.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [f.member.id]);
    expect(await identity.syncMember({ workosUserId: `user_${randomUUID().replace(/-/g, '')}`, email, emailVerified: true, role: 'member' }))
      .toMatchObject({ outcome: 'denied_inactive', status: 'inactive', userId: f.member.id });
    expect((await usersOf(f.tenant.id)).find((u) => u.id === f.member.id)!.status).toBe('inactive');
    // Invalid role is rejected by the function.
    await expect(withTenantTransaction(f.tenant, undefined, (tx) => tx.query(`SELECT * FROM app.sync_member('user_x', 'a@b.pe', true, 'owner')`))).rejects.toThrow('invalid role');
  });

  it('app.sync_member is not callable without a bound tenant and app_user cannot write users directly', async () => {
    const f = await createTenant();
    await expect(getPool().query(`SELECT * FROM app.sync_member('user_x', 'a@b.pe', true, 'member')`)).rejects.toThrow();
    expect(await sqlState(withTenantTransaction(f.tenant, f.admin, (tx) => tx.query(
      `INSERT INTO users (tenant_id, workos_user_id, email, role, status) VALUES ($1, 'user_forged', 'f@ejemplo.pe', 'admin', 'active')`, [f.tenant.id])))).toBe('42501');
  });

  it('a member is refused on every account operation and nothing changes', async () => {
    const f = await createTenant();
    const before = await usersOf(f.tenant.id);
    const repo = repos(f.tenant, f.member).tenantAccounts;
    for (const call of [
      () => repo.listAudit(),
      () => repo.setMirrorStatus({ workosUserId: 'user_x', status: 'inactive' }),
      () => repo.recordAudit({ action: 'member.deactivate', targetUserId: null, targetEmail: null, beforeStatus: null, afterStatus: null, reason: null, outcome: 'refused', outcomeCode: 'x' }),
    ]) await expect(call()).rejects.toBeInstanceOf(NotTenantAdminError);
    expect(await usersOf(f.tenant.id)).toEqual(before);
    expect(await auditOf(f.tenant.id)).toEqual([]);
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
});
