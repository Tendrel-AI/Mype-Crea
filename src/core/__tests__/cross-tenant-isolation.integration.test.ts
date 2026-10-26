/**
 * KAN-17: exercise tenant isolation against a disposable PostgreSQL database.
 * The owner URL only creates and removes synthetic fixtures; every application
 * read/write below uses repos() and the APP_DATABASE_URL app_user connection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool } from '../../db/pool';
import { repos, type Tenant, type User } from '../../repos';
import { withTenantTransaction } from '../../db/with-transaction';
import type { UUID } from '../contracts';

interface Fixture {
  tenant: Tenant;
  user: User;
  otherUser: User;
  conversationId: UUID;
  messageId: UUID;
  taskId: UUID;
  deliverableId: UUID;
  auditId: UUID;
}

const schemas = [] as const;

function requiredUrl(name: 'DATABASE_URL' | 'APP_DATABASE_URL'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for cross-tenant isolation tests`);
  return value;
}

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const ownerDatabase = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(ownerDatabase) || app.pathname.slice(1) !== ownerDatabase) {
    throw new Error('Isolation tests require the same disposable database ending in _ci or _test');
  }
  if (owner.hostname !== app.hostname || owner.port !== app.port) {
    throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same PostgreSQL host and port');
  }
  if (owner.username === 'app_user' || app.username !== 'app_user') {
    throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
  }
}

async function createFixture(
  owner: pg.Client,
  label: string,
): Promise<Fixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const conversationId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`,
    [tenantId, `CI isolation ${label} ${tenantId}`],
  );
  await owner.query(
    `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status)
     VALUES ($1, $2, $3, $4, 'admin', 'active')`,
    [userId, tenantId, `ci-${userId}`, `${userId}@example.invalid`],
  );
  await owner.query(
    `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status)
     VALUES ($1, $2, $3, $4, 'member', 'active')`,
    [otherUserId, tenantId, `ci-${otherUserId}`, `${otherUserId}@example.invalid`],
  );

  const tenant = { id: tenantId };
  const user = { id: userId };
  const conversation = await repos(tenant, user).conversations.getOrCreate(conversationId, schemas);
  expect(conversation.conversationId).toBe(conversationId);

  const message = await repos(tenant, user).messages.insert({
    conversationId,
    role: 'user',
    content: `synthetic ${label} message`,
  });
  const task = await repos(tenant, user).agentTasks.insertRoot({
    conversationId,
    agentId: 'logo-agent',
    agentCardVersion: 'ci-test',
    idempotencyKey: randomUUID(),
    requirementsSnapshot: { business_name: `synthetic ${label}` },
  });
  const deliverable = await repos(tenant, user).deliverables.insert({
    conversationId,
    agentTaskId: task.id,
    kind: 'logo',
    contentInline: { label: `synthetic ${label}` },
  });

  const auditId = randomUUID();
  await owner.query(
    `INSERT INTO ai_config_audit_events (id, tenant_id, actor_user_id, action, metadata)
     VALUES ($1, $2, $3, 'ci_isolation_fixture', $4::jsonb)`,
    [auditId, tenantId, userId, JSON.stringify({ label })],
  );

  return {
    tenant,
    user,
    otherUser: { id: otherUserId },
    conversationId,
    messageId: message.id,
    taskId: task.id,
    deliverableId: deliverable.id,
    auditId,
  };
}

describe('cross-tenant isolation (PostgreSQL integration)', () => {
  let owner: pg.Client;
  let tenantA: Fixture;
  let tenantB: Fixture;

  beforeAll(async () => {
    const databaseUrl = requiredUrl('DATABASE_URL');
    const appDatabaseUrl = requiredUrl('APP_DATABASE_URL');
    assertDisposableTarget(databaseUrl, appDatabaseUrl);
    owner = new pg.Client({ connectionString: databaseUrl });
    await owner.connect();
    const role = await owner.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'`,
    );
    if (!role.rows[0]?.rolcanlogin || role.rows[0].rolbypassrls) {
      throw new Error('app_user must be a login role without BYPASSRLS');
    }
    const appIdentity = await withTenantTransaction({ id: randomUUID() }, undefined, (tx) =>
      tx.query<{ current_user: string; current_database: string }>(
        `SELECT current_user, current_database()`,
      ),
    );
    const ownerIdentity = await owner.query<{ current_database: string }>(`SELECT current_database()`);
    if (appIdentity.rows[0]?.current_user !== 'app_user' ||
        appIdentity.rows[0]?.current_database !== ownerIdentity.rows[0]?.current_database) {
      throw new Error('APP_DATABASE_URL must connect as app_user to the setup database');
    }

    tenantA = await createFixture(owner, 'A');
    tenantB = await createFixture(owner, 'B');
  });

  afterAll(async () => {
    // The target database is disposable. Audit rows are append-only, so
    // deleting fixture tenants would violate the production invariant.
    if (owner) await owner.end();
    await closePool();
  });

  it('allows tenant-owned reads and writes while hiding and rejecting foreign rows', async () => {
    const ownA = repos(tenantA.tenant, tenantA.user);
    const ownB = repos(tenantB.tenant, tenantB.user);
    const otherUserA = repos(tenantA.tenant, tenantA.otherUser);

    // Own records are usable through the same repositories used by the app.
    expect((await ownA.conversations.get(tenantA.conversationId, schemas))?.conversationId)
      .toBe(tenantA.conversationId);
    expect((await ownA.messages.listByConversation(tenantA.conversationId)).map((row) => row.id))
      .toContain(tenantA.messageId);
    expect((await ownA.agentTasks.findById(tenantA.taskId))?.id).toBe(tenantA.taskId);
    expect((await ownA.deliverables.listByConversation(tenantA.conversationId)).map((row) => row.id))
      .toContain(tenantA.deliverableId);
    await ownA.messages.insert({
      conversationId: tenantA.conversationId,
      role: 'assistant',
      content: 'synthetic own-tenant write',
    });

    // Tenant B cannot read tenant A's records, even when it knows every UUID.
    expect(await ownB.conversations.get(tenantA.conversationId, schemas)).toBeUndefined();
    expect(await ownB.messages.listByConversation(tenantA.conversationId)).toEqual([]);
    expect(await ownB.agentTasks.findById(tenantA.taskId)).toBeNull();
    expect(await ownB.deliverables.listByConversation(tenantA.conversationId)).toEqual([]);

    // A second member in tenant A still cannot read another user's content.
    expect(await otherUserA.conversations.get(tenantA.conversationId, schemas)).toBeUndefined();
    expect(await otherUserA.messages.listByConversation(tenantA.conversationId)).toEqual([]);
    expect(await otherUserA.deliverables.listByConversation(tenantA.conversationId)).toEqual([]);
    expect((await otherUserA.agentTasks.findById(tenantA.taskId))?.id).toBe(tenantA.taskId);

    // Cross-tenant writes fail at RLS WITH CHECK, and a foreign update affects
    // no rows. These use the real app_user transaction pool and transaction GUCs.
    await expect(withTenantTransaction(tenantA.tenant, tenantA.user, async (tx) => {
      await tx.query(
        `INSERT INTO messages (tenant_id, conversation_id, user_id, role, content)
         VALUES ($1, $2, $3, 'user', 'must be rejected')`,
        [tenantB.tenant.id, tenantB.conversationId, tenantB.user.id],
      );
    })).rejects.toMatchObject({ code: '42501' });

    await expect(withTenantTransaction(tenantA.tenant, tenantA.user, (tx) =>
      tx.query(
        `INSERT INTO agent_tasks
           (id, tenant_id, conversation_id, agent_id, agent_card_version,
            idempotency_key, iteration_root_id, iteration_number, requirements_snapshot)
         VALUES ($1, $2, $3, 'logo-agent', 'ci-test', $4, $1, 1, '{}'::jsonb)`,
        [randomUUID(), tenantB.tenant.id, tenantB.conversationId, randomUUID()],
      ),
    )).rejects.toMatchObject({ code: '42501' });

    await expect(withTenantTransaction(tenantA.tenant, tenantA.user, (tx) =>
      tx.query(
        `INSERT INTO deliverables
           (tenant_id, conversation_id, agent_task_id, user_id, kind, content_inline)
         VALUES ($1, $2, $3, $4, 'logo', '{}'::jsonb)`,
        [tenantB.tenant.id, tenantB.conversationId, tenantB.taskId, tenantB.user.id],
      ),
    )).rejects.toMatchObject({ code: '42501' });

    await expect(withTenantTransaction(tenantA.tenant, tenantA.user, (tx) =>
      tx.query(
        `INSERT INTO ai_config_audit_events (tenant_id, actor_user_id, action)
         VALUES ($1, $2, 'must_be_rejected')`,
        [tenantB.tenant.id, tenantB.user.id],
      ),
    )).rejects.toMatchObject({ code: '42501' });

    await expect(ownA.agentTasks.insertRoot({
      conversationId: tenantA.conversationId,
      agentId: 'logo-agent',
      agentCardVersion: 'ci-test',
      idempotencyKey: randomUUID(),
      requirementsSnapshot: { foreignConversationId: tenantB.conversationId },
    })).rejects.toThrow(/JSONB tenant safety/);

    const hiddenUpdate = await withTenantTransaction(tenantB.tenant, tenantB.user, (tx) =>
      tx.query(`UPDATE conversations SET completed_at = now() WHERE id = $1`, [tenantA.conversationId]),
    );
    expect(hiddenUpdate.rowCount).toBe(0);

    const visibleAudit = await withTenantTransaction(tenantA.tenant, tenantA.user, (tx) =>
      tx.query(`SELECT id FROM ai_config_audit_events WHERE id = $1`, [tenantA.auditId]),
    );
    const hiddenAudit = await withTenantTransaction(tenantB.tenant, tenantB.user, (tx) =>
      tx.query(`SELECT id FROM ai_config_audit_events WHERE id = $1`, [tenantA.auditId]),
    );
    const otherUserAudit = await withTenantTransaction(tenantA.tenant, tenantA.otherUser, (tx) =>
      tx.query(`SELECT id FROM ai_config_audit_events WHERE id = $1`, [tenantA.auditId]),
    );
    expect(visibleAudit.rowCount).toBe(1);
    expect(hiddenAudit.rowCount).toBe(0);
    expect(otherUserAudit.rowCount).toBe(0);
  });

  it('KAN-52: a stored asset key is readable only by its owner, never across tenants or members', async () => {
    const ownA = repos(tenantA.tenant, tenantA.user);
    const task = await ownA.agentTasks.insertRoot({
      conversationId: tenantA.conversationId,
      agentId: 'logo-agent',
      agentCardVersion: 'ci-test',
      idempotencyKey: randomUUID(),
      requirementsSnapshot: { business_name: 'synthetic stored asset' },
    });
    const storageKey = `tenants/${tenantA.tenant.id}/conversations/${tenantA.conversationId}/tasks/${task.id}/0.png`;
    const settled = await ownA.aiTurns.settleTaskAndEnqueue({
      conversationId: tenantA.conversationId as never,
      taskId: task.id as never,
      state: 'completed',
      deliverableKind: 'logo',
      artifacts: [{ kind: 'image', url: 'https://provider.invalid/a.png', storageKey }],
    });
    const [deliverableId] = settled.deliverableIds;

    expect(await ownA.deliverables.findOwnStorageKey(deliverableId)).toBe(storageKey);
    // Tenant B knows the UUID but RLS hides the row; a second member of tenant A is not the owner.
    expect(await repos(tenantB.tenant, tenantB.user).deliverables.findOwnStorageKey(deliverableId)).toBeNull();
    expect(await repos(tenantA.tenant, tenantA.otherUser).deliverables.findOwnStorageKey(deliverableId)).toBeNull();
    // A legacy row without a key is never served.
    expect(await ownA.deliverables.findOwnStorageKey(tenantA.deliverableId)).toBeNull();

    // A row cannot point at another tenant's objects.
    await expect(withTenantTransaction(tenantA.tenant, tenantA.user, (tx) =>
      tx.query(
        `INSERT INTO deliverables
           (tenant_id, conversation_id, agent_task_id, user_id, kind, content_url, storage_key)
         VALUES ($1, $2, $3, $4, 'logo', 'https://provider.invalid/b.png', $5)`,
        [tenantA.tenant.id, tenantA.conversationId, task.id, tenantA.user.id, `tenants/${tenantB.tenant.id}/x.png`],
      ),
    )).rejects.toMatchObject({ code: '23514' });
  });
});

