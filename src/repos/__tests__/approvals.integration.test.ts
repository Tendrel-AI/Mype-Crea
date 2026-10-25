/**
 * KAN-34 (RF-06) / KAN-65: approvals, staleness and refinement persistence against a
 * disposable PostgreSQL database. DATABASE_URL (owner) only creates synthetic fixtures and
 * inspects rows; every product assertion goes through app_user repositories or
 * withTenantTransaction. Refuses to run unless both URLs point at the same database whose
 * name ends in _ci or _test. Do not run against .env.local or shared databases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { withTenantAdminTransaction, withTenantTransaction } from '../../db/with-transaction';
import { repos, type Tenant, type User } from '..';
import { createPostgresApprovalStore } from '../approval-store';
import { RefinementValidationError } from '../refinement-rules';
import { RefinementTargetError } from '../refinements';
import type { DeliverableKind } from '../models';
import type { UUID } from '../../core/contracts';
import { REFINEMENT_PARITY_CASES } from './fixtures/refinement-parity-cases';

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) {
    throw new Error('Approvals integration tests require one disposable database ending in _ci or _test');
  }
  if (owner.hostname !== app.hostname || owner.port !== app.port) {
    throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  }
  if (owner.username === 'app_user' || app.username !== 'app_user') {
    throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
  }
}

interface TenantFixture {
  tenant: Tenant;
  member: User;
  otherMember: User;
  admin: User;
}

SUITE('KAN-34 approvals, staleness and refinement (integration)', () => {
  let owner: pg.Client;
  let A: TenantFixture;
  let B: TenantFixture;

  async function createTenant(label: string): Promise<TenantFixture> {
    const tenantId = randomUUID();
    await owner.query(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [
      tenantId,
      `KAN-34 ${label} ${tenantId}`,
    ]);
    const mk = async (role: 'admin' | 'member'): Promise<User> => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [id, tenantId, `kan34-${id}`, `${id}@example.invalid`, role],
      );
      return { id };
    };
    return { tenant: { id: tenantId }, member: await mk('member'), otherMember: await mk('member'), admin: await mk('admin') };
  }

  async function newConversation(t: Tenant, u: User): Promise<UUID> {
    const id = randomUUID();
    await repos(t, u).conversations.getOrCreate(id, []);
    return id;
  }

  /** A completed task with `n` deliverables of `kind` (the candidates). */
  async function candidates(
    t: Tenant,
    u: User,
    conversationId: UUID,
    kind: DeliverableKind,
    n: number,
    opts: { complete?: boolean; snapshot?: Record<string, unknown> } = {},
  ): Promise<{ taskId: UUID; ids: UUID[] }> {
    const r = repos(t, u);
    const task = await r.agentTasks.insertRoot({
      conversationId,
      agentId: `${kind}-agent`,
      agentCardVersion: 'kan34-test',
      idempotencyKey: randomUUID(),
      requirementsSnapshot: opts.snapshot ?? { business_name: 'Sazón Andino' },
    });
    const ids: UUID[] = [];
    for (let i = 0; i < n; i += 1) {
      const d = await r.deliverables.insert({
        conversationId,
        agentTaskId: task.id,
        kind,
        contentInline: { option: i },
      });
      ids.push(d.id);
    }
    if (opts.complete !== false) await r.agentTasks.markCompleted(task.id);
    return { taskId: task.id, ids };
  }

  async function selectedRows(conversationId: UUID, kind: DeliverableKind) {
    const res = await owner.query<{ id: UUID; selected_at: Date | null; superseded_by: UUID | null }>(
      `SELECT id, selected_at, superseded_by FROM deliverables
        WHERE conversation_id = $1 AND kind = $2 ORDER BY created_at, id`,
      [conversationId, kind],
    );
    return res.rows;
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
    if (!role.rows[0]?.rolcanlogin || role.rows[0].rolbypassrls) {
      throw new Error('app_user must be a login role without BYPASSRLS');
    }
    const who = await getPool().query<{ current_user: string }>('SELECT current_user');
    if (who.rows[0]?.current_user !== 'app_user') throw new Error('APP_DATABASE_URL must be app_user');
    A = await createTenant('A');
    B = await createTenant('B');
  });

  afterAll(async () => {
    if (owner) await owner.end();
    await closePool();
  });

  it('schema: RLS forced, append-only grants, and the refinement CHECK exist', async () => {
    const rls = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('deliverable_approvals', 'deliverable_stale_marks') ORDER BY relname`,
    );
    expect(rls.rows).toEqual([
      { relname: 'deliverable_approvals', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'deliverable_stale_marks', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const grants = await owner.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'app_user' AND table_name IN ('deliverable_approvals', 'deliverable_stale_marks')
        ORDER BY table_name, privilege_type`,
    );
    expect(grants.rows).toEqual([
      { table_name: 'deliverable_approvals', privilege_type: 'INSERT' },
      { table_name: 'deliverable_approvals', privilege_type: 'SELECT' },
      { table_name: 'deliverable_stale_marks', privilege_type: 'INSERT' },
      { table_name: 'deliverable_stale_marks', privilege_type: 'SELECT' },
    ]);
    const check = await owner.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'agent_tasks_refinement_valid' AND convalidated`,
    );
    expect(check.rowCount).toBe(1);
  });

  it('approves the first candidate, then replaces it keeping the full trail', async () => {
    const conv = await newConversation(A.tenant, A.member);
    const { ids: [first, second] } = await candidates(A.tenant, A.member, conv, 'logo', 2);
    const store = createPostgresApprovalStore(A.tenant, A.member);

    const r1 = await store.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId: first, expectedApprovedId: null });
    expect(r1).toMatchObject({ ok: true, replacedDeliverableId: null });
    expect(await store.getApproved(conv)).toEqual([
      { deliverableKind: 'logo', deliverableId: first, approvedAt: expect.any(String) },
    ]);

    const r2 = await store.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId: second, expectedApprovedId: first });
    expect(r2).toMatchObject({ ok: true, replacedDeliverableId: first });
    expect((await store.getApproved(conv)).map((a) => a.deliverableId)).toEqual([second]);

    const history = await repos(A.tenant, A.member).approvals.listHistory(conv);
    expect(history.map((h) => [h.deliverableId, h.replacedDeliverableId, h.approvedBy])).toEqual([
      [first, null, A.member.id],
      [second, first, A.member.id],
    ]);
    expect(history[0].eventSeq).toBeLessThan(history[1].eventSeq);
    expect(r1.ok && history[0].id).toBe(r1.ok && r1.approvalId);
    expect(r2.ok && history[1].id).toBe(r2.ok && r2.approvalId);

    // Index-consistent: exactly one selected row; the replaced one points at its replacement.
    const rows = await selectedRows(conv, 'logo');
    expect(rows.filter((r) => r.selected_at !== null).map((r) => r.id)).toEqual([second]);
    expect(rows.find((r) => r.id === first)?.superseded_by).toBe(second);
    expect(rows.find((r) => r.id === second)?.superseded_by).toBeNull();

    // Re-approving the replaced one again flips it back and clears its superseded_by.
    const r3 = await store.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId: first, expectedApprovedId: second });
    expect(r3).toMatchObject({ ok: true, replacedDeliverableId: second });
    const after = await selectedRows(conv, 'logo');
    expect(after.find((r) => r.id === first)).toMatchObject({ superseded_by: null });
    expect(after.find((r) => r.id === second)).toMatchObject({ selected_at: null, superseded_by: first });
    expect(await repos(A.tenant, A.member).approvals.listHistory(conv, 'logo')).toHaveLength(3);
  });

  it('rejects a stale expected id and treats a matching re-approval as a no-op', async () => {
    const conv = await newConversation(A.tenant, A.member);
    const { ids: [x, y, z] } = await candidates(A.tenant, A.member, conv, 'logo', 3);
    const store = createPostgresApprovalStore(A.tenant, A.member);
    await store.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId: x, expectedApprovedId: null });
    const ry = await store.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId: y, expectedApprovedId: x });
    expect(ry.ok).toBe(true);

    for (const expectedApprovedId of [x, null, randomUUID(), 'not-a-uuid']) {
      expect(
        await store.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId: z, expectedApprovedId }),
      ).toEqual({ ok: false, reason: 'stale' });
    }
    const same = await store.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId: y, expectedApprovedId: y });
    expect(same).toEqual({ ok: true, approvalId: ry.ok ? ry.approvalId : '', replacedDeliverableId: null });
    expect(await repos(A.tenant, A.member).approvals.listHistory(conv)).toHaveLength(2);
    expect((await store.getApproved(conv)).map((a) => a.deliverableId)).toEqual([y]);
  });

  it('serializes concurrent approvals: exactly one wins, the others are stale', async () => {
    const conv = await newConversation(A.tenant, A.member);
    const { ids } = await candidates(A.tenant, A.member, conv, 'logo', 5);
    const store = createPostgresApprovalStore(A.tenant, A.member);

    // Hold the conversation lock so every approval is queued behind it before any runs.
    const blocker = await getPool().connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT set_config('app.tenant_id', $1, true)`, [A.tenant.id]);
      await blocker.query(`SELECT set_config('app.user_id', $1, true)`, [A.member.id]);
      const locked = await blocker.query(`SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE`, [conv]);
      expect(locked.rowCount).toBe(1);

      const racing = ids.map((deliverableId) =>
        store.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId, expectedApprovedId: null }),
      );
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND usename = 'app_user' AND wait_event_type = 'Lock'`,
        );
        if (waiting.rows[0].n >= ids.length) break;
        if (Date.now() > deadline) throw new Error('approvals never queued on the conversation lock');
        await new Promise((r) => setTimeout(r, 25));
      }
      await blocker.query('COMMIT');

      const results = await Promise.all(racing);
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual(Array(ids.length - 1).fill({ ok: false, reason: 'stale' }));
      const history = await repos(A.tenant, A.member).approvals.listHistory(conv);
      expect(history).toHaveLength(1);
      expect((await selectedRows(conv, 'logo')).filter((r) => r.selected_at !== null)).toHaveLength(1);
    } finally {
      blocker.release();
    }

    // Unblocked parallel run with distinct expected ids also yields one winner.
    const current = (await store.getApproved(conv))[0].deliverableId;
    const others = ids.filter((id) => id !== current);
    const results = await Promise.all(
      others.map((deliverableId) =>
        store.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId, expectedApprovedId: current }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await repos(A.tenant, A.member).approvals.listHistory(conv)).toHaveLength(2);
  });

  it('rejects wrong conversation, wrong kind, unfinished tasks, unknown ids and other owners', async () => {
    const conv = await newConversation(A.tenant, A.member);
    const otherConv = await newConversation(A.tenant, A.member);
    const { ids: [logo] } = await candidates(A.tenant, A.member, conv, 'logo', 1);
    const { ids: [foreignLogo] } = await candidates(A.tenant, A.member, otherConv, 'logo', 1);
    const { ids: [tagline] } = await candidates(A.tenant, A.member, conv, 'tagline', 1);
    const { ids: [pending] } = await candidates(A.tenant, A.member, conv, 'logo', 1, { complete: false });
    const store = createPostgresApprovalStore(A.tenant, A.member);
    const approve = (deliverableId: string, deliverableKind = 'logo', conversationId: string = conv) =>
      store.approve({ conversationId, deliverableKind, deliverableId, expectedApprovedId: null });

    expect(await approve(foreignLogo)).toEqual({ ok: false, reason: 'not_candidate' });
    expect(await approve(tagline)).toEqual({ ok: false, reason: 'not_candidate' });
    expect(await approve(pending)).toEqual({ ok: false, reason: 'not_candidate' });
    expect(await approve(logo, 'banner')).toEqual({ ok: false, reason: 'not_candidate' });
    expect(await approve(randomUUID())).toEqual({ ok: false, reason: 'not_found' });
    expect(await approve('not-a-uuid')).toEqual({ ok: false, reason: 'not_found' });
    expect(await approve(logo, 'logo', randomUUID())).toEqual({ ok: false, reason: 'not_found' });

    // Another ordinary member of the same tenant cannot approve inside this conversation.
    const intruder = createPostgresApprovalStore(A.tenant, A.otherMember);
    expect(
      await intruder.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId: logo, expectedApprovedId: null }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(await intruder.getApproved(conv)).toEqual([]);

    expect(await repos(A.tenant, A.member).approvals.listHistory(conv)).toEqual([]);
    expect((await approve(logo)).ok).toBe(true);
  });

  it('isolates tenants and owners for reads and writes', async () => {
    const conv = await newConversation(A.tenant, A.member);
    const { ids: [logo] } = await candidates(A.tenant, A.member, conv, 'logo', 1);
    const res = await createPostgresApprovalStore(A.tenant, A.member).approve({
      conversationId: conv, deliverableKind: 'logo', deliverableId: logo, expectedApprovedId: null,
    });
    expect(res.ok).toBe(true);
    await repos(A.tenant, A.member).approvals.markStale({ conversationId: conv, deliverableKinds: ['tagline'] });

    // Tenant B (even knowing every id) sees nothing and cannot approve or mark.
    const foreign = repos(B.tenant, B.member).approvals;
    expect(await foreign.listHistory(conv)).toEqual([]);
    expect(await foreign.getApproved(conv)).toEqual([]);
    expect(await foreign.listStale(conv)).toEqual([]);
    expect(
      await foreign.approve({ conversationId: conv, deliverableKind: 'logo', deliverableId: logo, expectedApprovedId: logo }),
    ).toEqual({ kind: 'rejected', reason: 'not_found' });
    await expect(foreign.markStale({ conversationId: conv, deliverableKinds: ['logo'] })).rejects.toThrow(
      'conversation not found',
    );
    const rawRead = await withTenantTransaction(B.tenant, B.member, (tx) =>
      tx.query(`SELECT 1 FROM deliverable_approvals WHERE conversation_id = $1
                UNION ALL SELECT 1 FROM deliverable_stale_marks WHERE conversation_id = $1`, [conv]),
    );
    expect(rawRead.rowCount).toBe(0);

    // Raw cross-tenant and cross-owner inserts fail RLS WITH CHECK.
    const insertApproval = (t: Tenant, u: User, row: { tenant: UUID; user: UUID; by: UUID }) =>
      withTenantTransaction(t, u, (tx) =>
        tx.query(
          `INSERT INTO deliverable_approvals
             (tenant_id, conversation_id, user_id, deliverable_kind, deliverable_id, approved_by)
           VALUES ($1, $2, $3, 'logo', $4, $5)`,
          [row.tenant, conv, row.user, logo, row.by],
        ),
      );
    await expect(insertApproval(B.tenant, B.member, { tenant: A.tenant.id, user: A.member.id, by: A.member.id }))
      .rejects.toMatchObject({ code: '42501' });
    await expect(insertApproval(A.tenant, A.otherMember, { tenant: A.tenant.id, user: A.member.id, by: A.otherMember.id }))
      .rejects.toMatchObject({ code: '42501' });
    await expect(insertApproval(A.tenant, A.member, { tenant: A.tenant.id, user: A.member.id, by: A.otherMember.id }))
      .rejects.toMatchObject({ code: '42501' });
    await expect(withTenantTransaction(B.tenant, B.member, (tx) =>
      tx.query(
        `INSERT INTO deliverable_stale_marks (tenant_id, conversation_id, user_id, deliverable_kind, marked_by)
         VALUES ($1, $2, $3, 'logo', $3)`,
        [A.tenant.id, conv, A.member.id],
      ),
    )).rejects.toMatchObject({ code: '42501' });

    // Same tenant, other member: no read. Tenant admin context: read.
    expect(await repos(A.tenant, A.otherMember).approvals.listHistory(conv)).toEqual([]);
    const adminRead = await withTenantAdminTransaction(A.tenant, (tx) =>
      tx.query(`SELECT id FROM deliverable_approvals WHERE conversation_id = $1`, [conv]),
    );
    expect(adminRead.rowCount).toBe(1);
  });

  it('keeps history append-only for members and the owner, while conversation deletes cascade', async () => {
    const conv = await newConversation(A.tenant, A.member);
    const { ids: [logo] } = await candidates(A.tenant, A.member, conv, 'logo', 1);
    await repos(A.tenant, A.member).approvals.approve({
      conversationId: conv, deliverableKind: 'logo', deliverableId: logo, expectedApprovedId: null,
    });
    await repos(A.tenant, A.member).approvals.markStale({ conversationId: conv, deliverableKinds: ['tagline'] });

    for (const table of ['deliverable_approvals', 'deliverable_stale_marks']) {
      await expect(withTenantTransaction(A.tenant, A.member, (tx) =>
        tx.query(`UPDATE ${table} SET user_id = user_id WHERE conversation_id = $1`, [conv]),
      )).rejects.toMatchObject({ code: '42501' });
      await expect(withTenantTransaction(A.tenant, A.member, (tx) =>
        tx.query(`DELETE FROM ${table} WHERE conversation_id = $1`, [conv]),
      )).rejects.toMatchObject({ code: '42501' });
      await expect(withTenantAdminTransaction(A.tenant, (tx) =>
        tx.query(`DELETE FROM ${table} WHERE conversation_id = $1`, [conv]),
      )).rejects.toMatchObject({ code: '42501' });
      // Even the schema owner cannot rewrite or delete rows directly.
      await expect(owner.query(`UPDATE ${table} SET event_seq = event_seq WHERE conversation_id = $1`, [conv]))
        .rejects.toThrow(/append-only/);
      await expect(owner.query(`DELETE FROM ${table} WHERE conversation_id = $1`, [conv]))
        .rejects.toThrow(/append-only/);
    }

    // event_seq and timestamps are server-assigned even if a client supplies them.
    const forged = await withTenantTransaction(A.tenant, A.member, (tx) =>
      tx.query<{ event_seq: string; marked_at: Date }>(
        `INSERT INTO deliverable_stale_marks
           (tenant_id, conversation_id, user_id, deliverable_kind, marked_by, event_seq, marked_at)
         VALUES ($1, $2, $3, 'label', $3, 9000000000000000, '2000-01-01')
         RETURNING event_seq, marked_at`,
        [A.tenant.id, conv, A.member.id],
      ),
    );
    expect(Number(forged.rows[0].event_seq)).toBeLessThan(9e15);
    expect(forged.rows[0].marked_at.getUTCFullYear()).toBeGreaterThanOrEqual(2026);

    // Retention: deleting the conversation cascades through both event tables.
    await owner.query(`DELETE FROM conversations WHERE id = $1`, [conv]);
    const left = await owner.query(
      `SELECT 1 FROM deliverable_approvals WHERE conversation_id = $1
       UNION ALL SELECT 1 FROM deliverable_stale_marks WHERE conversation_id = $1`,
      [conv],
    );
    expect(left.rowCount).toBe(0);
  });

  it('marks dependents stale without regenerating, and a later approval of the kind clears it', async () => {
    const conv = await newConversation(A.tenant, A.member);
    const r = repos(A.tenant, A.member);
    const store = createPostgresApprovalStore(A.tenant, A.member);
    const { ids: [tag1, tag2] } = await candidates(A.tenant, A.member, conv, 'tagline', 2);
    await store.approve({ conversationId: conv, deliverableKind: 'tagline', deliverableId: tag1, expectedApprovedId: null });
    const tasksBefore = (await r.agentTasks.listByConversation(conv)).length;

    await store.markDependentsStale({ conversationId: conv, deliverableKinds: ['tagline', 'label', 'tagline'] });
    expect((await r.approvals.listStale(conv)).map((s) => s.deliverableKind)).toEqual(['tagline', 'label']);
    expect((await r.agentTasks.listByConversation(conv)).length).toBe(tasksBefore);
    expect((await store.getApproved(conv)).map((a) => a.deliverableId)).toEqual([tag1]);

    // Re-approving the same deliverable is a no-op and does not clear staleness.
    await store.approve({ conversationId: conv, deliverableKind: 'tagline', deliverableId: tag1, expectedApprovedId: tag1 });
    expect((await r.approvals.listStale(conv)).map((s) => s.deliverableKind)).toEqual(['tagline', 'label']);

    await store.approve({ conversationId: conv, deliverableKind: 'tagline', deliverableId: tag2, expectedApprovedId: tag1 });
    expect((await r.approvals.listStale(conv)).map((s) => s.deliverableKind)).toEqual(['label']);

    // A newer mark makes it stale again; the marks themselves are never removed.
    await store.markDependentsStale({ conversationId: conv, deliverableKinds: ['tagline'] });
    expect((await r.approvals.listStale(conv)).map((s) => s.deliverableKind)).toEqual(['tagline', 'label']);
    const marks = await owner.query(`SELECT 1 FROM deliverable_stale_marks WHERE conversation_id = $1`, [conv]);
    expect(marks.rowCount).toBe(3);

    await expect(store.markDependentsStale({ conversationId: conv, deliverableKinds: ['banner'] })).rejects.toThrow(
      'unknown deliverable kinds',
    );
    await expect(
      createPostgresApprovalStore(A.tenant, A.otherMember).markDependentsStale({ conversationId: conv, deliverableKinds: ['label'] }),
    ).rejects.toThrow('conversation not found');
    await expect(store.markDependentsStale({ conversationId: conv, deliverableKinds: [] })).resolves.toBeUndefined();
  });

  it('stores a capped, anchored refinement on the iteration only and never touches the brief', async () => {
    const conv = await newConversation(A.tenant, A.member);
    const brief = { 'logo-agent': { requiredFields: { business_name: { status: 'filled', value: 'Sazón Andino' } } } };
    await owner.query(`UPDATE conversations SET agent_states = $2::jsonb WHERE id = $1`, [conv, JSON.stringify(brief)]);
    const briefBefore = await owner.query(`SELECT agent_states FROM conversations WHERE id = $1`, [conv]);
    const { taskId, ids: [, anchor] } = await candidates(A.tenant, A.member, conv, 'logo', 2, {
      snapshot: { business_name: 'Sazón Andino', style_keywords: 'minimalista' },
    });
    const r = repos(A.tenant, A.member);

    const it2 = await r.refinements.createIteration({
      parentTaskId: taskId,
      idempotencyKey: randomUUID(),
      iterationTrigger: 'user_reject',
      refinement: {
        parameterChanges: { primaryColor: 'azul', iconSize: 2 },
        observations: ['  Hazlo más azul  ', 'Letras más gruesas'],
        anchorDeliverableId: anchor,
      },
    });
    expect(it2).toMatchObject({
      parentTaskId: taskId,
      iterationRootId: taskId,
      iterationNumber: 2,
      iterationTrigger: 'user_reject',
      status: 'pending',
      agentId: 'logo-agent',
      agentCardVersion: 'kan34-test',
    });
    expect(it2.requirementsSnapshot).toEqual({
      business_name: 'Sazón Andino',
      style_keywords: 'minimalista',
      refinement: {
        parameterChanges: { primaryColor: 'azul', iconSize: 2 },
        observations: ['Hazlo más azul', 'Letras más gruesas'],
        anchorDeliverableId: anchor,
      },
    });

    // Iterating the iteration: overrides are iteration-local, not carried forward.
    await r.agentTasks.markCompleted(it2.id);
    const it3 = await r.refinements.createIteration({
      parentTaskId: it2.id,
      idempotencyKey: randomUUID(),
      iterationTrigger: 'user_regenerate',
      refinement: { observations: ['Fondo blanco'] },
    });
    expect(it3).toMatchObject({ parentTaskId: it2.id, iterationRootId: taskId, iterationNumber: 3 });
    expect(it3.requirementsSnapshot.refinement).toEqual({
      parameterChanges: {},
      observations: ['Fondo blanco'],
      anchorDeliverableId: null,
    });

    // Caps are enforced before any write.
    const countTasks = async () =>
      (await owner.query(`SELECT 1 FROM agent_tasks WHERE conversation_id = $1`, [conv])).rowCount;
    const before = await countTasks();
    const tooMany = r.refinements.createIteration({
      parentTaskId: taskId, idempotencyKey: randomUUID(), iterationTrigger: 'user_reject',
      refinement: { observations: ['a', 'b', 'c', 'd', 'e', 'f'] },
    });
    await expect(tooMany).rejects.toBeInstanceOf(RefinementValidationError);
    await expect(tooMany).rejects.toMatchObject({
      code: 'too_many_observations',
      message: 'Puedes escribir como máximo 5 observaciones.',
    });
    await expect(r.refinements.createIteration({
      parentTaskId: taskId, idempotencyKey: randomUUID(), iterationTrigger: 'user_reject',
      refinement: { observations: ['x'.repeat(501)] },
    })).rejects.toMatchObject({ code: 'observation_too_long' });
    expect(await countTasks()).toBe(before);

    // Ownership, anchor and parent-state checks.
    await expect(repos(A.tenant, A.otherMember).refinements.createIteration({
      parentTaskId: taskId, idempotencyKey: randomUUID(), iterationTrigger: 'user_reject', refinement: {},
    })).rejects.toMatchObject({ reason: 'parent_not_found' });
    await expect(repos(B.tenant, B.member).refinements.createIteration({
      parentTaskId: taskId, idempotencyKey: randomUUID(), iterationTrigger: 'user_reject', refinement: {},
    })).rejects.toBeInstanceOf(RefinementTargetError);
    const { ids: [otherTaskDeliverable] } = await candidates(A.tenant, A.member, conv, 'logo', 1);
    await expect(r.refinements.createIteration({
      parentTaskId: taskId, idempotencyKey: randomUUID(), iterationTrigger: 'user_reject',
      refinement: { anchorDeliverableId: otherTaskDeliverable },
    })).rejects.toMatchObject({ reason: 'anchor_not_in_parent' });
    await expect(r.refinements.createIteration({
      parentTaskId: it3.id, idempotencyKey: randomUUID(), iterationTrigger: 'user_reject', refinement: {},
    })).rejects.toMatchObject({ reason: 'parent_not_completed' });

    // Database backstop: a write that bypasses the repository is still capped.
    const rawInsert = (parent: UUID | null, number: number, refinement: unknown) =>
      withTenantTransaction(A.tenant, A.member, (tx) => {
        const id = randomUUID();
        return tx.query(
          `INSERT INTO agent_tasks
             (id, tenant_id, conversation_id, agent_id, agent_card_version, idempotency_key,
              iteration_root_id, iteration_number, parent_task_id, requirements_snapshot)
           VALUES ($1, $2, $3, 'logo-agent', 'raw', $4, $5, $6, $7, $8::jsonb)`,
          [id, A.tenant.id, conv, randomUUID(), parent ? taskId : id, number, parent, JSON.stringify({ refinement })],
        );
      });
    await expect(rawInsert(taskId, 9, { parameterChanges: {}, observations: Array(6).fill('a') }))
      .rejects.toMatchObject({ code: '23514', constraint: 'agent_tasks_refinement_valid' });
    await expect(rawInsert(null, 1, { parameterChanges: {}, observations: [] }))
      .rejects.toMatchObject({ code: '23514', constraint: 'agent_tasks_refinement_valid' });
    await expect(rawInsert(taskId, 9, { parameterChanges: {}, observations: ['ok'] })).resolves.toBeDefined();

    const briefAfter = await owner.query(`SELECT agent_states FROM conversations WHERE id = $1`, [conv]);
    expect(briefAfter.rows[0].agent_states).toEqual(briefBefore.rows[0].agent_states);
  });

  it('app.is_valid_refinement agrees with the TypeScript rule on every parity case', async () => {
    const verdicts = await withTenantTransaction(A.tenant, A.member, async (tx) => {
      const out: Array<[string, boolean]> = [];
      for (const c of REFINEMENT_PARITY_CASES) {
        const res = await tx.query<{ ok: boolean }>(`SELECT app.is_valid_refinement($1::jsonb) AS ok`, [
          JSON.stringify(c.value),
        ]);
        out.push([c.name, res.rows[0].ok]);
      }
      return out;
    });
    expect(verdicts).toEqual(REFINEMENT_PARITY_CASES.map((c) => [c.name, c.valid]));
  });
});
