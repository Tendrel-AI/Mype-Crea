/**
 * KAN-42 (SYS-07): conversation trace reconstruction and access against a disposable PostgreSQL
 * database. One seeded session (two turns with attempts, LLM calls, messages and a notice, a
 * generated and approved logo, a refused write, usage reservations, terms acceptance) must come
 * back complete and in order in under 5 s for the owner and the tenant admin; another member and
 * another tenant get nothing; a platform operator gets the metadata-only view with no content;
 * and the metrics report computes p95, per-deliverable latency and mean cost for the seeded data.
 * DATABASE_URL (owner) only seeds; every product path runs as app_user. Refuses to run unless
 * both URLs point at the same database whose name ends in _ci or _test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { withTenantTransaction } from '../../db/with-transaction';
import { repos, type Tenant, type User } from '..';
import { globalRepos } from '../global';
import type { ConversationId } from '../../core/contracts';
import type { TraceEventKind } from '../conversation-trace';
import { computePilotMetrics } from '../../services/trace/pilot-metrics';

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) {
    throw new Error('Conversation-trace integration tests require one disposable database ending in _ci or _test');
  }
  if (owner.hostname !== app.hostname || owner.port !== app.port) {
    throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  }
  if (owner.username === 'app_user' || app.username !== 'app_user') {
    throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
  }
}

// Monday 2026-10-26 10:00 America/Lima: inside operating hours, so latencies count.
const BASE = Date.parse('2026-10-26T15:00:00.000Z');
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();

// Strings that are business content: none may appear in the platform view.
const SECRETS = {
  userText: 'Quiero un logo para Panadería Secreta',
  brandValue: 'Panadería Secreta',
  reply: 'Perfecto, ¿qué estilo prefieres para tu marca?',
  prompt: 'PROMPT-SECRETO extractor request',
  notice: 'Aviso secreto de respaldo',
  providerUrl: 'https://fal.example/secret-logo.png',
  hash: 'c'.repeat(64),
};

SUITE('KAN-42 conversation trace (integration)', () => {
  let owner: pg.Client;
  const platformActor = `kan42-platform-${randomUUID()}`;
  const tenantA: Tenant = { id: randomUUID() };
  const tenantB: Tenant = { id: randomUUID() };
  const member: User = { id: randomUUID() };
  const other: User = { id: randomUUID() };
  const admin: User = { id: randomUUID() };
  const outsider: User = { id: randomUUID() };
  const conversationId = randomUUID() as ConversationId;
  const otherConversationId = randomUUID() as ConversationId;
  /** [kind, refId] in the order the owner must see them. */
  const ownerExpected: Array<[TraceEventKind, string | null]> = [];
  let forgedRejectionId = '';

  async function seed(): Promise<void> {
    const q = (sql: string, params: unknown[] = []) => owner.query(sql, params);
    const id = () => randomUUID();
    for (const [tenant, name] of [[tenantA, 'A'], [tenantB, 'B']] as const) {
      await q(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [tenant.id, `KAN-42 ${name} ${tenant.id}`]);
    }
    const mkUser = (tenant: Tenant, user: User, role: 'admin' | 'member') => q(
      `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
      [user.id, tenant.id, `kan42-${user.id}`, `${user.id}@example.invalid`, role],
    );
    await mkUser(tenantA, member, 'member');
    await mkUser(tenantA, other, 'member');
    await mkUser(tenantA, admin, 'admin');
    await mkUser(tenantB, outsider, 'admin');
    await q(`INSERT INTO platform_superadmins (workos_user_id, grant_source) VALUES ($1, 'authorized')`, [platformActor]);

    await q('BEGIN');
    await q(`SET LOCAL session_replication_role = 'replica'`);
    const releaseId = id();
    await q(
      `INSERT INTO ai_releases (id, tenant_id, name, status, manifest, canonical_content, content_hash, created_by, updated_by, frozen_at)
       VALUES ($1, $2, 'KAN-42', 'frozen', '{}'::jsonb, '{}', $3, $4, $4, $5)`,
      [releaseId, tenantA.id, 'a'.repeat(64), admin.id, at(-3600)],
    );
    const agentStates = { 'logo-agent': { requiredFields: { business_name: { status: 'filled', value: SECRETS.brandValue, confidence: 0.9, source: 'chat-input' } }, optionalFields: {}, iterationCount: 0 } };
    for (const [conv, user] of [[conversationId, member], [otherConversationId, other]] as const) {
      await q(
        `INSERT INTO conversations (id, tenant_id, user_id, ai_release_id, configuration_state, started_at, agent_states)
         VALUES ($1, $2, $3, $4, 'pinned', $5, $6)`,
        [conv, tenantA.id, user.id, releaseId, at(0), JSON.stringify(conv === conversationId ? agentStates : {})],
      );
    }
    ownerExpected.push(['conversation', conversationId]);

    const termsId = id();
    await q(`INSERT INTO terms_acceptances (id, tenant_id, user_id, terms_version, accepted_at) VALUES ($1, $2, $3, 'terminos-v1', $4)`, [termsId, tenantA.id, member.id, at(-60)]);
    ownerExpected.unshift(['terms_acceptance', termsId]);

    // Two responded turns: 1.5 s and 2.5 s.
    for (const [index, start, duration] of [[1, 10, 1.5], [2, 60, 2.5]] as const) {
      const turnId = id();
      const payload = {
        delta: { source: 'chat-input', fields: { 'logo-agent': { business_name: { value: SECRETS.brandValue, confidence: 0.9 } } } },
        decisions: [{ kind: index === 1 ? 'ask_field' : 'offer_generation' }],
      };
      await q(
        `INSERT INTO ai_turns (id, tenant_id, user_id, conversation_id, release_id, request_id, input_hash, input_content, response_content, stage, payload, created_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'responded', $10, $11, $12)`,
        [turnId, tenantA.id, member.id, conversationId, releaseId, id(), 'd'.repeat(64), SECRETS.userText, SECRETS.reply, JSON.stringify(payload), at(start), at(start + duration)],
      );
      ownerExpected.push(['turn', turnId]);
      const reservationId = id();
      const attemptId = id();
      await q(
        `INSERT INTO usage_reservations (id, tenant_id, user_id, kind, status, estimated_cost_usd, actual_cost_usd, outcome, pricing_version, provider, model, conversation_id, turn_id, attempt_id, created_at, settled_at)
         VALUES ($1, $2, $3, 'llm', 'settled', 0.02, 0.005, 'succeeded', 'pricing-v1', 'openrouter', 'model-x', $4, $5, $6, $7, $8)`,
        [reservationId, tenantA.id, member.id, conversationId, turnId, attemptId, at(start + 0.1), at(start + 1)],
      );
      ownerExpected.push(['usage_reservation', reservationId]);
      await q(
        `INSERT INTO ai_turn_attempts (id, tenant_id, user_id, conversation_id, turn_id, release_id, purpose, attempt_number, primary_profile_id, effective_profile_id, provider, model, model_revision, status, request_content, response_content, input_tokens, output_tokens, latency_ms, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'extractor', 1, 'primary', 'primary', 'openrouter', 'model-x', 'rev-1', 'succeeded', $7, '{}', 100, 20, 700, $8, $9)`,
        [attemptId, tenantA.id, member.id, conversationId, turnId, releaseId, SECRETS.prompt, at(start + 0.2), at(start + 0.9)],
      );
      ownerExpected.push(['attempt', attemptId]);
      const llmCallId = id();
      await q(
        `INSERT INTO llm_calls (id, tenant_id, conversation_id, user_id, provider, purpose, model, model_revision, prompt_version, input_tokens, output_tokens, latency_ms, occurred_at)
         VALUES ($1, $2, $3, $4, 'openrouter', 'extractor', 'model-x', 'rev-1', 'extractor.v4', 100, 20, 700, $5)`,
        [llmCallId, tenantA.id, conversationId, member.id, at(start + 0.95)],
      );
      ownerExpected.push(['llm_call', llmCallId]);
      for (const [role, content, offset] of [['user', SECRETS.userText, 1.1], ['assistant', SECRETS.reply, 1.2]] as const) {
        const messageId = id();
        await q(
          `INSERT INTO messages (id, tenant_id, conversation_id, user_id, role, content, ai_turn_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [messageId, tenantA.id, conversationId, member.id, role, content, turnId, at(start + offset)],
        );
        ownerExpected.push(['message', messageId]);
      }
      if (index === 2) {
        const noticeId = id();
        await q(
          `INSERT INTO ai_turn_notices (id, tenant_id, user_id, conversation_id, turn_id, code, content, created_at) VALUES ($1, $2, $3, $4, $5, 'approved_fallback_used', $6, $7)`,
          [noticeId, tenantA.id, member.id, conversationId, turnId, SECRETS.notice, at(start + 1.3)],
        );
        ownerExpected.push(['notice', noticeId]);
      }
    }

    // A refused panel write by the owner, and a forged one by another member with this id.
    const rejectionId = id();
    await q(
      `INSERT INTO write_rejections (id, tenant_id, user_id, channel, conversation_id, agent_id, field_name, reason, payload_hash, created_at)
       VALUES ($1, $2, $3, 'panel', $4, 'logo-agent', 'tenant_id', 'unknown_field', $5, $6)`,
      [rejectionId, tenantA.id, member.id, conversationId, SECRETS.hash, at(90)],
    );
    ownerExpected.push(['write_rejection', rejectionId]);
    forgedRejectionId = id();
    await q(
      `INSERT INTO write_rejections (id, tenant_id, user_id, channel, conversation_id, reason, payload_hash, created_at)
       VALUES ($1, $2, $3, 'chat', $4, 'conversation_unavailable', $5, $6)`,
      [forgedRejectionId, tenantA.id, other.id, conversationId, SECRETS.hash, at(95)],
    );

    // Generar → logo task (30 s) → stored deliverable → outbox event → Aprobar.
    const taskId = id();
    await q(
      `INSERT INTO agent_tasks (id, tenant_id, conversation_id, agent_id, agent_card_version, status, idempotency_key, iteration_root_id, requirements_snapshot, dispatched_at, completed_at, created_at)
       VALUES ($1, $2, $3, 'logo-agent', '1.0.0', 'completed', $4, $1, $5, $6, $7, $8)`,
      [taskId, tenantA.id, conversationId, id(), JSON.stringify({ business_name: SECRETS.brandValue }), at(100.5), at(130), at(100)],
    );
    ownerExpected.push(['task', taskId]);
    const imageReservationId = id();
    await q(
      `INSERT INTO usage_reservations (id, tenant_id, user_id, kind, status, estimated_cost_usd, actual_cost_usd, outcome, pricing_version, provider, model, agent_task_id, created_at, settled_at)
       VALUES ($1, $2, $3, 'image', 'settled', 0.08, 0.08, 'succeeded', 'pricing-v1', 'fal', 'flux', $4, $5, $6)`,
      [imageReservationId, tenantA.id, member.id, taskId, at(101), at(129)],
    );
    ownerExpected.push(['usage_reservation', imageReservationId]);
    const deniedId = id();
    await q(
      `INSERT INTO usage_reservations (id, tenant_id, user_id, kind, status, denial_reason, estimated_cost_usd, pricing_version, conversation_id, created_at)
       VALUES ($1, $2, $3, 'image', 'denied', 'user_image_daily', 0.08, 'pricing-v1', $4, $5)`,
      [deniedId, tenantA.id, member.id, conversationId, at(102)],
    );
    ownerExpected.push(['usage_reservation', deniedId]);
    ownerExpected.push(['task_settled', taskId]);
    const deliverableId = id();
    await q(
      `INSERT INTO deliverables (id, tenant_id, conversation_id, agent_task_id, user_id, kind, content_url, storage_key, created_at)
       VALUES ($1, $2, $3, $4, $5, 'logo', $6, $7, $8)`,
      [deliverableId, tenantA.id, conversationId, taskId, member.id, SECRETS.providerUrl, `tenants/${tenantA.id}/conversations/${conversationId}/tasks/${taskId}/0.png`, at(130.1)],
    );
    ownerExpected.push(['deliverable', deliverableId]);
    await q(
      `INSERT INTO ai_turn_events (tenant_id, user_id, conversation_id, task_id, event_id, kind, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, 'artifact', '{}'::jsonb, $6)`,
      [tenantA.id, member.id, conversationId, taskId, `task_completed:${taskId}`, at(130.2)],
    );
    ownerExpected.push(['outbox_event', null]);
    const approvalId = id();
    await q(
      `INSERT INTO deliverable_approvals (id, tenant_id, conversation_id, user_id, deliverable_kind, deliverable_id, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, 'logo', $5, $4, $6)`,
      [approvalId, tenantA.id, conversationId, member.id, deliverableId, at(200)],
    );
    ownerExpected.push(['approval', approvalId]);

    // Noise that must never reach this conversation's timeline: another member's conversation.
    await q(
      `INSERT INTO llm_calls (tenant_id, conversation_id, user_id, provider, purpose, model, model_revision, prompt_version, input_tokens, output_tokens, latency_ms, occurred_at)
       VALUES ($1, $2, $3, 'openrouter', 'responder', 'model-y', 'rev-1', 'responder.v6', 1, 1, 1, $4)`,
      [tenantA.id, otherConversationId, other.id, at(50)],
    );
    await q(
      `INSERT INTO usage_reservations (tenant_id, user_id, kind, status, estimated_cost_usd, pricing_version, conversation_id, created_at)
       VALUES ($1, $2, 'llm', 'reserved', 0.5, 'pricing-v1', $3, $4)`,
      [tenantA.id, other.id, otherConversationId, at(50)],
    );
    await q('COMMIT');
  }

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL!;
    const appUrl = process.env.APP_DATABASE_URL!;
    assertDisposableTarget(ownerUrl, appUrl);
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const who = await getPool().query<{ current_user: string }>('SELECT current_user');
    if (who.rows[0]?.current_user !== 'app_user') throw new Error('APP_DATABASE_URL must be app_user');
    await seed();
  });

  afterAll(async () => {
    if (owner) await owner.end();
    await closePool();
  });

  const actor = (role: 'admin' | 'member') => ({ workosUserId: 'kan42', platformAdmin: false, tenantRole: role });

  it('owner: every seeded event, in order, with content, in under 5 s', async () => {
    const started = performance.now();
    const timeline = await repos(tenantA, member, actor('member')).trace.timeline(conversationId);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(5000);
    expect(timeline?.access).toBe('owner');
    expect(timeline!.events.map((event) => [event.kind, event.refId])).toEqual(ownerExpected);
    expect(timeline!.events.map((event) => event.seq)).toEqual(ownerExpected.map((_, index) => index + 1));
    const byKind = (kind: TraceEventKind) => timeline!.events.filter((event) => event.kind === kind);
    // Content, provenance, versions and correlation are all there.
    expect(byKind('turn')[0]).toMatchObject({
      meta: { deltaSource: 'chat-input', fields: [{ agentId: 'logo-agent', fieldName: 'business_name', confidence: 0.9 }], decisionKinds: ['ask_field'], durationMs: 1500 },
      content: { input: SECRETS.userText, response: SECRETS.reply },
    });
    expect(byKind('conversation')[0].meta).toMatchObject({ releaseContentHash: 'a'.repeat(64), brief: [{ fieldName: 'business_name', status: 'filled', source: 'chat-input' }] });
    expect(byKind('llm_call')[0].meta).toMatchObject({ model: 'model-x', modelRevision: 'rev-1', promptVersion: 'extractor.v4' });
    const task = byKind('task')[0];
    expect(task.meta).toMatchObject({ agentId: 'logo-agent', agentCardVersion: '1.0.0', inputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(byKind('deliverable')[0].meta.inputFingerprint).toBe(task.meta.inputFingerprint);
    expect(byKind('usage_reservation')[2].meta).toMatchObject({ kind: 'image', agentTaskId: task.refId });
    expect(byKind('task_settled')[0].meta).toMatchObject({ status: 'completed', durationMs: 30_000 });
    // KAN-52: the stored image is the asset route; no provider URL or bucket key.
    expect(byKind('deliverable')[0].content).toMatchObject({ contentUrl: `/api/assets/${byKind('deliverable')[0].refId}` });
    const json = JSON.stringify(timeline);
    expect(json).not.toContain(SECRETS.providerUrl);
    expect(json).not.toContain('storageKey');
    // The forged rejection by another member stays hidden from the owner, as do their rows.
    expect(json).not.toContain(forgedRejectionId);
    expect(json).not.toContain('model-y');
  });

  it('tenant admin: the same timeline plus every member row on it (the forged rejection)', async () => {
    const started = performance.now();
    const timeline = await repos(tenantA, admin, actor('admin')).trace.timeline(conversationId);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(timeline?.access).toBe('tenant_admin');
    const expected = [...ownerExpected];
    expected.splice(expected.findIndex(([kind]) => kind === 'write_rejection') + 1, 0, ['write_rejection', forgedRejectionId]);
    expect(timeline!.events.map((event) => [event.kind, event.refId])).toEqual(expected);
    expect(JSON.stringify(timeline)).toContain(SECRETS.userText);
  });

  it('another member, a forged admin actor, and another tenant get nothing', async () => {
    expect(await repos(tenantA, other, actor('member')).trace.timeline(conversationId)).toBeUndefined();
    // Claiming admin in the actor is not enough: the persisted role is re-checked.
    expect(await repos(tenantA, other, actor('admin')).trace.timeline(conversationId)).toBeUndefined();
    expect(await repos(tenantB, outsider, actor('admin')).trace.timeline(conversationId)).toBeUndefined();
    // Calling the SQL directly as a member returns no rows, and the platform function refuses.
    const rows = await withTenantTransaction(tenantA, other, (tx) => tx.query(`SELECT * FROM app.conversation_trace_events($1, $2)`, [tenantA.id, conversationId]));
    expect(rows.rows).toEqual([]);
    await expect(withTenantTransaction(tenantA, admin, (tx) => tx.query(`SELECT * FROM app.platform_conversation_trace($1, $2)`, [tenantA.id, conversationId])))
      .rejects.toThrow(/platform actor/);
  });

  it('platform operator: metadata only, same sequence, no content', async () => {
    const trace = await globalRepos().trace.conversationMetadata(tenantA.id, conversationId, platformActor);
    const adminView = await repos(tenantA, admin, actor('admin')).trace.timeline(conversationId);
    expect(trace.events.map((event) => [event.seq, event.kind, event.refId])).toEqual(adminView!.events.map((event) => [event.seq, event.kind, event.refId]));
    const json = JSON.stringify(trace);
    for (const secret of Object.values(SECRETS)) expect(json).not.toContain(secret);
    for (const userId of [member.id, other.id, admin.id]) expect(json).not.toContain(userId);
    expect(trace.events.every((event) => !('content' in event))).toBe(true);
    await expect(globalRepos().trace.conversationMetadata(tenantA.id, conversationId, 'kan42-not-an-operator')).rejects.toThrow(/authorization/);
  });

  it('monthly sample picks conversations per tenant for the operator only', async () => {
    const sample = await globalRepos().trace.sampleConversations('2026-10', 100, platformActor);
    const mine = sample.filter((row) => row.tenantId === tenantA.id).map((row) => row.conversationId).sort();
    expect(mine).toEqual([conversationId, otherConversationId].sort());
    await expect(globalRepos().trace.sampleConversations('2026-10', 1, 'kan42-not-an-operator')).rejects.toThrow(/authorization/);
  });

  it('metrics report: p95, per-deliverable latency and mean cost per set for the seeded data', async () => {
    const samples = await globalRepos().trace.metricSamples(at(-3600), at(86_400), platformActor);
    const report = computePilotMetrics(samples.filter((sample) => sample.tenantId === tenantA.id));
    expect(report.interaction).toMatchObject({ count: 2, p95Ms: 2500, meanMs: 2000 });
    expect(report.deliverableLatency).toEqual({ 'logo-agent': { count: 1, meanMs: 30_000, p50Ms: 30_000, p95Ms: 30_000 } });
    // One set (the conversation with a completed logo): 0.005 + 0.005 + 0.08; denied rows excluded.
    expect(report.costPerSet.sets).toBe(1);
    expect(report.costPerSet.meanUsd).toBeCloseTo(0.09, 6);
    expect(report.ownAvailability.measured).toBe(false);
  });
});
