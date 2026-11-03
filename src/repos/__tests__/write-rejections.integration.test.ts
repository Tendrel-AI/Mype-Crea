/**
 * KAN-44 (SYS-11): the `write_rejections` log against a disposable PostgreSQL database.
 * Proves the append-only grants, the server timestamp, the hash-only CHECK, and the read
 * policy (a member reads only their own rows, an active tenant admin reads the tenant's,
 * another tenant reads nothing), plus that a forged conversation id from another user or
 * tenant raises `ConversationUnavailableError` without creating a row. DATABASE_URL (owner)
 * only seeds and inspects; every product path runs as app_user. Refuses to run unless both
 * URLs point at the same database whose name ends in _ci or _test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { withTenantTransaction } from '../../db/with-transaction';
import { repos, type Tenant, type User } from '..';
import { ConversationUnavailableError } from '../conversations';
import type { ConversationId, UUID } from '../../core/contracts';
import type { WriteRejectionInput } from '../write-rejections';

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) {
    throw new Error('Write-rejection integration tests require one disposable database ending in _ci or _test');
  }
  if (owner.hostname !== app.hostname || owner.port !== app.port) {
    throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  }
  if (owner.username === 'app_user' || app.username !== 'app_user') {
    throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
  }
}

const HASH = 'b'.repeat(64);
const row = (overrides: Partial<WriteRejectionInput> = {}): WriteRejectionInput => ({
  channel: 'panel',
  conversationId: null,
  agentId: 'logo-agent',
  fieldName: 'tenant_id',
  reason: 'unknown_field',
  payloadHash: HASH,
  ...overrides,
});

SUITE('KAN-44 write rejections (integration)', () => {
  let owner: pg.Client;

  async function createTenant(): Promise<{ tenant: Tenant; member: User; other: User; admin: User }> {
    const tenantId = randomUUID();
    await owner.query(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [tenantId, `KAN-44 ${tenantId}`]);
    const mk = async (role: 'admin' | 'member'): Promise<User> => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
        [id, tenantId, `kan44-${id}`, `${id}@example.invalid`, role],
      );
      return { id };
    };
    return { tenant: { id: tenantId }, member: await mk('member'), other: await mk('member'), admin: await mk('admin') };
  }

  /** A frozen release activated for the tenant, plus one pinned conversation of `user` (owner, replica mode). */
  async function seedReleaseAndConversation(tenant: Tenant, user: User): Promise<ConversationId> {
    const releaseId = randomUUID();
    const conversationId = randomUUID() as ConversationId;
    await owner.query('BEGIN');
    try {
      await owner.query(`SET LOCAL session_replication_role = 'replica'`);
      await owner.query(
        `INSERT INTO ai_releases (id, tenant_id, name, status, manifest, canonical_content, content_hash, created_by, updated_by, frozen_at)
         VALUES ($1, $2, $3, 'frozen', '{}'::jsonb, '{}', $4, $5, $5, now())`,
        [releaseId, tenant.id, `KAN-44 ${releaseId}`, 'a'.repeat(64), user.id],
      );
      await owner.query(
        `INSERT INTO ai_release_activations (tenant_id, release_id, version, updated_by) VALUES ($1, $2, 1, $3)`,
        [tenant.id, releaseId, user.id],
      );
      await owner.query(
        `INSERT INTO conversations (id, tenant_id, user_id, ai_release_id, configuration_state) VALUES ($1, $2, $3, $4, 'pinned')`,
        [conversationId, tenant.id, user.id, releaseId],
      );
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
    return conversationId;
  }

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL!;
    const appUrl = process.env.APP_DATABASE_URL!;
    assertDisposableTarget(ownerUrl, appUrl);
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const role = await owner.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'`,
    );
    if (!role.rows[0]?.rolcanlogin || role.rows[0].rolbypassrls) throw new Error('app_user must be a login role without BYPASSRLS');
    const who = await getPool().query<{ current_user: string }>('SELECT current_user');
    if (who.rows[0]?.current_user !== 'app_user') throw new Error('APP_DATABASE_URL must be app_user');
  });

  afterAll(async () => {
    if (owner) await owner.end();
    await closePool();
  });

  it('schema: RLS forced; app_user gets SELECT and INSERT only, never on id or created_at', async () => {
    const rls = await owner.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'write_rejections'`);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const privileges = await owner.query(
      `SELECT has_table_privilege('app_user', 'write_rejections', 'SELECT') AS sel,
              has_table_privilege('app_user', 'write_rejections', 'UPDATE') AS upd,
              has_table_privilege('app_user', 'write_rejections', 'DELETE') AS del,
              has_table_privilege('app_user', 'write_rejections', 'TRUNCATE') AS trunc,
              has_column_privilege('app_user', 'write_rejections', 'id', 'INSERT') AS ins_id,
              has_column_privilege('app_user', 'write_rejections', 'created_at', 'INSERT') AS ins_created,
              has_column_privilege('app_user', 'write_rejections', 'payload_hash', 'INSERT') AS ins_hash`,
    );
    expect(privileges.rows[0]).toEqual({
      sel: true, upd: false, del: false, trunc: false, ins_id: false, ins_created: false, ins_hash: true,
    });
  });

  it('records with a database timestamp; a member reads only their own rows, the admin reads the tenant', async () => {
    const t = await createTenant();
    const before = Date.now();
    await repos(t.tenant, t.member).writeRejections.record([row(), row({ channel: 'chat', fieldName: 'tone', agentId: 'tagline-agent' })]);
    await repos(t.tenant, t.other).writeRejections.record([row({ channel: 'command', agentId: null, fieldName: null, reason: 'command_invalid' })]);

    const mine = await repos(t.tenant, t.member).writeRejections.list();
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.userId === t.member.id && r.payloadHash === HASH)).toBe(true);
    expect(new Set(mine.map((r) => r.channel))).toEqual(new Set(['panel', 'chat']));
    for (const r of mine) expect(Date.parse(r.createdAt)).toBeGreaterThanOrEqual(before - 5_000);

    const others = await repos(t.tenant, t.other).writeRejections.list();
    expect(others.map((r) => r.userId)).toEqual([t.other.id]);

    const admin = await repos(t.tenant, t.admin).writeRejections.list();
    expect(admin).toHaveLength(3);

    const b = await createTenant();
    expect(await repos(b.tenant, b.admin).writeRejections.list()).toEqual([]);
  });

  it('refuses forged actors, client timestamps, raw values, UPDATE and DELETE', async () => {
    const t = await createTenant();
    const b = await createTenant();
    await repos(t.tenant, t.member).writeRejections.record([row()]);

    const asMember = (sql: string, params: unknown[]) =>
      withTenantTransaction(t.tenant, t.member, (tx) => tx.query(sql, params));
    const insert = `INSERT INTO write_rejections (tenant_id, user_id, channel, reason, payload_hash) VALUES ($1, $2, 'panel', 'unknown_field', $3)`;

    await expect(asMember(insert, [t.tenant.id, t.other.id, HASH])).rejects.toMatchObject({ code: '42501' });
    await expect(asMember(insert, [b.tenant.id, b.member.id, HASH])).rejects.toMatchObject({ code: '42501' });
    await expect(asMember(insert, [t.tenant.id, t.member.id, 'Café Andino'])).rejects.toMatchObject({ code: '23514' });
    await expect(asMember(insert, [t.tenant.id, t.member.id, 'B'.repeat(64)])).rejects.toMatchObject({ code: '23514' });
    await expect(
      asMember(
        `INSERT INTO write_rejections (tenant_id, user_id, channel, reason, payload_hash, created_at) VALUES ($1, $2, 'panel', 'x', $3, now() - interval '1 day')`,
        [t.tenant.id, t.member.id, HASH],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asMember(`UPDATE write_rejections SET reason = 'edited'`, [])).rejects.toMatchObject({ code: '42501' });
    await expect(asMember(`DELETE FROM write_rejections`, [])).rejects.toMatchObject({ code: '42501' });

    const remaining = await owner.query(`SELECT count(*)::int AS n FROM write_rejections WHERE tenant_id = $1`, [t.tenant.id]);
    expect(remaining.rows[0].n).toBe(1);
  });

  it('a forged conversation id from another user or tenant raises ConversationUnavailableError and creates nothing', async () => {
    const t = await createTenant();
    const b = await createTenant();
    const owned = await seedReleaseAndConversation(t.tenant, t.member);
    await seedReleaseAndConversation(b.tenant, b.member);

    const count = async () =>
      (await owner.query(`SELECT count(*)::int AS n FROM conversations WHERE id = $1`, [owned])).rows[0].n as number;

    for (const intruder of [{ tenant: t.tenant, user: t.other }, { tenant: b.tenant, user: b.member }]) {
      await expect(
        repos(intruder.tenant, intruder.user).conversations.ensurePinnedConversation({ conversationId: owned, schemas: [] }),
      ).rejects.toBeInstanceOf(ConversationUnavailableError);
    }
    expect(await count()).toBe(1);
    const stillOwned = await owner.query<{ tenant_id: UUID; user_id: UUID }>(
      `SELECT tenant_id, user_id FROM conversations WHERE id = $1`, [owned],
    );
    expect(stillOwned.rows[0]).toEqual({ tenant_id: t.tenant.id, user_id: t.member.id });
  });
});
