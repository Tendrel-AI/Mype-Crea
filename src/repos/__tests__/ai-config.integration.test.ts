/**
 * Real app_user/RLS integration coverage for KAN-70 persistence.
 *
 * This suite is intentionally gated on both APP_DATABASE_URL and DATABASE_URL.
 * DATABASE_URL is used only to create/delete randomly generated fixtures and
 * inspect role flags; every product assertion goes through app_user-backed
 * repositories or withTenantTransaction. Run only after explicit approval.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { withTenantTransaction } from '../../db/with-transaction';
import { repos } from '..';
import { createBaselineDraft } from '../../services/ai-config/baseline';
import { AiConfigService } from '../../services/ai-config/service';
import { canonicalizeManifestJson, freezeManifest, type AiConfigManifestV1, type JsonValue } from '../../services/ai-config/manifest';
import type { ConversationId, TaskId, UUID } from '../../core/contracts';
import type { ResolvedIdentity } from '../../auth/resolve-identity';

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;
const TEST_PREFIX = 'kan70-integration-';
type FixtureUser = { id: UUID; workosUserId: string; role: 'admin' | 'member' };
type FixtureTenant = { id: UUID; organizationId: string; admin: FixtureUser; member: FixtureUser };

function workosId(): string {
  return `user_${randomUUID().replaceAll('-', '')}`;
}

function tenantId(): UUID {
  return randomUUID() as UUID;
}

function asIdentity(tenant: FixtureTenant, user: FixtureUser, platformAdmin = false): ResolvedIdentity {
  return {
    tenant: { id: tenant.id },
    user: { id: user.id },
    tenantRole: user.role,
    workosUserId: user.workosUserId,
    organizationId: tenant.organizationId,
    platformAdmin,
  };
}

function repository(identity: ResolvedIdentity) {
  return repos(identity.tenant, identity.user, {
    workosUserId: identity.workosUserId,
    platformAdmin: identity.platformAdmin,
    tenantRole: identity.tenantRole,
  });
}

function service(): AiConfigService {
  return new AiConfigService((identity) => repository(identity).aiConfig);
}

function copyManifest(manifest: AiConfigManifestV1): AiConfigManifestV1 {
  return JSON.parse(JSON.stringify(manifest)) as AiConfigManifestV1;
}

SUITE('AI configuration and durable turns (integration)', () => {
  let owner: pg.Client;
  let tenants: [FixtureTenant, FixtureTenant];
  let platformUser: FixtureUser;
  let baseline: AiConfigManifestV1;
  let sharedReleaseId: string;
  let sharedHash: string;
  let oldPlatformAllowlist: string | undefined;
  const tenantIds: UUID[] = [];
  const sharedActors: string[] = [];

  async function newPinnedConversation(tenant: FixtureTenant, user: FixtureUser): Promise<ConversationId> {
    const id = randomUUID() as ConversationId;
    const result = await repository(asIdentity(tenant, user)).conversations.ensurePinnedConversation({
      conversationId: id,
      schemas: [],
    });
    expect(result.state).toBe('pinned');
    return id;
  }

  async function makeTenantRelease(
    tenant: FixtureTenant,
    manifest = baseline,
    name = `${TEST_PREFIX}release-${randomUUID()}`,
  ) {
    const config = repository(asIdentity(tenant, tenant.admin)).aiConfig;
    const draft = await config.createDraft({ name, manifest });
    const frozen = await config.freezeDraft({ releaseId: draft!.id, expectedVersion: draft!.draftVersion });
    return frozen!;
  }

  async function makeSharedRelease(
    manifest = baseline,
    name = `${TEST_PREFIX}shared-${randomUUID()}`,
    allowedOverridePaths: readonly string[] = [],
  ) {
    const actor = asIdentity(tenants[0], platformUser, true);
    const config = repository(actor).aiConfig;
    const draft = await config.createSharedDraft({ name, manifest, allowedOverridePaths: [...allowedOverridePaths] });
    const frozen = await config.freezeSharedDraft({ releaseId: draft!.id, expectedVersion: draft!.draftVersion });
    return frozen!;
  }

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl || ownerUrl === appUrl) {
      throw new Error('Use distinct DATABASE_URL (fixture owner) and APP_DATABASE_URL (app_user) connections.');
    }
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const ownerRole = await owner.query<{ current_user: string }>('SELECT current_user');
    if (ownerRole.rows[0]?.current_user === 'app_user') {
      throw new Error('DATABASE_URL must use the fixture owner, not app_user.');
    }

    oldPlatformAllowlist = process.env.PLATFORM_ADMIN_WORKOS_USER_IDS;
    platformUser = { id: tenantId(), workosUserId: workosId(), role: 'member' };
    const a = createTenantFixture();
    const b = createTenantFixture();
    tenants = [a, b];
    tenantIds.push(a.id, b.id);
    sharedActors.push(platformUser.workosUserId);
    process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = platformUser.workosUserId;

    for (const tenant of tenants) {
      await owner.query(
        `INSERT INTO tenants(id,kind,name,plan,workos_org_id)
         VALUES($1,'institutional',$2,'test',$3)`,
        [tenant.id, `${TEST_PREFIX}${tenant.id}`, tenant.organizationId],
      );
      for (const user of [tenant.admin, tenant.member]) {
        await owner.query(
          `INSERT INTO users(id,tenant_id,workos_user_id,email,role,status)
           VALUES($1,$2,$3,$4,$5,'active')`,
          [user.id, tenant.id, user.workosUserId, `${user.workosUserId}@example.invalid`, user.role],
        );
      }
    }
    await owner.query(
      `INSERT INTO users(id,tenant_id,workos_user_id,email,role,status)
       VALUES($1,$2,$3,$4,'member','active')`,
      [platformUser.id, tenants[0].id, platformUser.workosUserId, `${platformUser.workosUserId}@example.invalid`],
    );
    const appRole = await getPool().query<{ current_user: string }>('SELECT current_user');
    if (appRole.rows[0]?.current_user !== 'app_user') {
      throw new Error('APP_DATABASE_URL must connect as app_user.');
    }
    baseline = await createBaselineDraft();
    const shared = await makeSharedRelease(baseline, `${TEST_PREFIX}initial-shared`, ['/planner/thresholds/maxFieldBatchSize']);
    sharedReleaseId = shared.id;
    sharedHash = shared.contentHash!;
    for (const tenant of tenants) {
      await service().activateShared(asIdentity(tenant, tenant.admin), {
        sharedReleaseId,
        expectedSharedVersion: shared.draftVersion,
        expectedActivationVersion: 0,
      });
    }
  });

  function createTenantFixture(): FixtureTenant {
    const admin: FixtureUser = { id: tenantId(), workosUserId: workosId(), role: 'admin' };
    const member: FixtureUser = { id: tenantId(), workosUserId: workosId(), role: 'member' };
    return {
      id: tenantId(),
      organizationId: `org_${randomUUID().replaceAll('-', '')}`,
      admin,
      member,
    };
  }

  afterAll(async () => {
    if (oldPlatformAllowlist === undefined) delete process.env.PLATFORM_ADMIN_WORKOS_USER_IDS;
    else process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = oldPlatformAllowlist;
    if (owner && tenantIds.length) {
      await owner.query('BEGIN');
      try {
        // Test-only teardown bypasses append-only/immutability triggers on this connection only.
        // IDs are the random tenant/user fixtures created by this suite; no pilot rows are touched.
        await owner.query(`SET LOCAL session_replication_role = 'replica'`);
        await owner.query(`DELETE FROM ai_turn_events WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM messages WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM ai_turn_notices WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM ai_turn_attempts WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM ai_turns WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM deliverables WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM agent_tasks WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM conversations WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM ai_release_activations WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM ai_provider_availability WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM ai_config_audit_events WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM ai_releases WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        if (sharedActors.length) {
          await owner.query(`DELETE FROM ai_shared_releases WHERE created_by_workos_user_id = ANY($1::text[])`, [sharedActors]);
        }
        await owner.query(`DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenantIds]);
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
      }
    }
    await owner?.end();
    await closePool();
  });

  it('uses app_user without BYPASSRLS and forces RLS on every KAN-70 table', async () => {
    const role = await owner.query<{ rolbypassrls: boolean }>(`SELECT rolbypassrls FROM pg_roles WHERE rolname='app_user'`);
    expect(role.rows[0]?.rolbypassrls).toBe(false);
    const tables = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
        WHERE relkind='r' AND relname = ANY($1::text[])`,
      [['ai_shared_releases','ai_releases','ai_release_activations','ai_config_audit_events','ai_provider_availability','ai_turns','ai_turn_attempts','ai_turn_notices','ai_turn_events']],
    );
    expect(tables.rows).toHaveLength(9);
    expect(tables.rows.every((table) => table.relrowsecurity && table.relforcerowsecurity)).toBe(true);
  });

  it('freezes canonical UTF-8/numeric JSON, clones shared releases, and pins old/new defaults immutably', async () => {
    const variant = copyManifest(baseline);
    const thresholds = variant.planner.thresholds as Record<string, JsonValue>;
    thresholds['é'] = 1e-7;
    thresholds['𐀀'] = 1e21;
    const jsFrozen = freezeManifest(variant);
    const canonical = canonicalizeManifestJson(jsFrozen.content as unknown as JsonValue);
    expect(canonical).toContain('"é":0.0000001');
    expect(canonical).toContain('"𐀀":1000000000000000000000');
    expect(canonical.indexOf('"é"')).toBeLessThan(canonical.indexOf('"𐀀"'));

    const unusualShared = await makeSharedRelease(variant, `${TEST_PREFIX}unicode-numeric`);
    expect(unusualShared.contentHash).toBe(jsFrozen.contentHash);
    expect(unusualShared.canonicalContent).toBe(canonicalizeManifestJson(jsFrozen.content as unknown as JsonValue));

    const tenant = tenants[0];
    const oldConversation = await newPinnedConversation(tenant, tenant.admin);
    const oldPin = await repository(asIdentity(tenant, tenant.admin)).conversations.readPinnedConversation(oldConversation, []);
    expect(oldPin?.releaseId).toBeTruthy();
    const oldReleaseId = oldPin!.releaseId!;
    const oldRelease = await repository(asIdentity(tenant, tenant.admin)).aiConfig.getRelease(oldReleaseId);
    expect(oldRelease?.baseSharedReleaseId).toBe(sharedReleaseId);
    expect(oldRelease?.contentHash).toBe(sharedHash);

    const activation = await repository(asIdentity(tenant, tenant.admin)).aiConfig.getActivation();
    await service().activateShared(asIdentity(tenant, tenant.admin), {
      sharedReleaseId: unusualShared.id,
      expectedSharedVersion: unusualShared.draftVersion,
      expectedActivationVersion: activation!.version,
    });
    const newConversation = await newPinnedConversation(tenant, tenant.admin);
    const newPin = await repository(asIdentity(tenant, tenant.admin)).conversations.readPinnedConversation(newConversation, []);
    expect(newPin?.releaseId).not.toBe(oldReleaseId);
    expect((await repository(asIdentity(tenant, tenant.admin)).aiConfig.getPinnedRelease(oldConversation))?.id).toBe(oldReleaseId);
    expect((await repository(asIdentity(tenant, tenant.admin)).aiConfig.getPinnedRelease(newConversation))?.contentHash).toBe(jsFrozen.contentHash);
    // A fresh repository read models a process restart: it derives the same immutable pin from DB.
    expect((await repos({ id: tenant.id }, { id: tenant.admin.id }).conversations.readPinnedConversation(oldConversation, []))?.releaseId).toBe(oldReleaseId);
  });

  it('separates platform allowlist authority from tenant admin role and enforces override paths', async () => {
    const tenant = tenants[0];
    const baselineHash = baseline.planner.thresholds.maxFieldBatchSize;
    const changed = copyManifest(baseline);
    (changed.planner.thresholds as Record<string, JsonValue>).maxFieldBatchSize = Number(baselineHash) + 1;

    const platformRepo = repository(asIdentity(tenant, platformUser, true)).aiConfig;
    const tenantAdminService = service();
    await expect(tenantAdminService.createSharedDraft(asIdentity(tenant, tenant.admin), {
      name: `${TEST_PREFIX}tenant-admin-is-not-platform`, manifest: baseline, allowedOverridePaths: [],
    })).rejects.toThrow(/platform admin/i);
    const platformDraft = await service().createSharedDraft(asIdentity(tenant, platformUser, true), {
      name: `${TEST_PREFIX}allowlisted-platform-member`, manifest: baseline, allowedOverridePaths: [],
    });
    expect(platformDraft.status).toBe('draft');

    await expect(tenantAdminService.createDraft(asIdentity(tenant, tenant.admin), { name: `${TEST_PREFIX}unbased`, manifest: baseline }))
      .rejects.toThrow(/platform admin/i);

    const override = await tenantAdminService.createOverrideDraft(asIdentity(tenant, tenant.admin), {
      sharedReleaseId,
      name: `${TEST_PREFIX}override`,
    });
    const update = await tenantAdminService.updateDraft(asIdentity(tenant, tenant.admin), {
      releaseId: override.id,
      expectedVersion: override.draftVersion,
      manifest: changed,
    });
    expect(update.manifest.planner.thresholds.maxFieldBatchSize).toBe(Number(baselineHash) + 1);

    const forbidden = copyManifest(baseline);
    (forbidden.planner.thresholds as Record<string, JsonValue>).maxFieldBatchSize = Number(baselineHash) + 2;
    const sharedWithoutOverrides = await makeSharedRelease(baseline, `${TEST_PREFIX}no-overrides`);
    const forbiddenDraft = await tenantAdminService.createOverrideDraft(asIdentity(tenant, tenant.admin), {
      sharedReleaseId: sharedWithoutOverrides.id,
      name: `${TEST_PREFIX}forbidden-override`,
    });
    await expect(tenantAdminService.updateDraft(asIdentity(tenant, tenant.admin), {
      releaseId: forbiddenDraft.id,
      expectedVersion: forbiddenDraft.draftVersion,
      manifest: forbidden,
    })).rejects.toThrow(/override|allowed|permitted/i);

    const priorAllowlist = process.env.PLATFORM_ADMIN_WORKOS_USER_IDS;
    process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = '';
    try {
      await expect(platformRepo.createSharedDraft({ name: `${TEST_PREFIX}not-allowlisted`, manifest: baseline, allowedOverridePaths: [] }))
        .rejects.toThrow(/permisos/i);
    } finally {
      process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = priorAllowlist;
    }
  });

  it('rejects foreign release IDs, serializes activation CAS, and versions provider disable/re-enable', async () => {
    const [tenantA, tenantB] = tenants;
    const releaseA = await makeTenantRelease(tenantA);
    const releaseB = await makeTenantRelease(tenantB);
    const repoA = repository(asIdentity(tenantA, tenantA.admin)).aiConfig;
    expect(await repoA.getRelease(releaseB.id)).toBeUndefined();
    await expect(repoA.activate({ releaseId: releaseB.id, expectedActivationVersion: 1 })).rejects.toThrow();
    const foreignConversation = await newPinnedConversation(tenantB, tenantB.admin);
    expect(await repository(asIdentity(tenantA, tenantA.admin)).conversations.readPinnedConversation(foreignConversation, [])).toBeUndefined();

    const current = await repoA.getActivation();
    const race = await Promise.allSettled([
      repoA.activate({ releaseId: releaseA.id, expectedActivationVersion: current!.version }),
      repoA.activate({ releaseId: releaseA.id, expectedActivationVersion: current!.version }),
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const initial = await repoA.getProviderAvailability('openrouter');
    const disabled = await repoA.setProviderAvailability({ provider: 'openrouter', enabled: false, expectedVersion: initial.version });
    expect(disabled).toMatchObject({ enabled: false, version: initial.version + 1 });
    await expect(repoA.setProviderAvailability({ provider: 'openrouter', enabled: true, expectedVersion: initial.version }))
      .rejects.toThrow(/versión|cambió/i);
    const enabled = await repoA.setProviderAvailability({ provider: 'openrouter', enabled: true, expectedVersion: disabled.version });
    expect(enabled).toMatchObject({ enabled: true, version: disabled.version + 1 });
  });

  it('enforces frozen content immutability and prevents retiring the active release', async () => {
    const tenant = tenants[0];
    const local = await makeTenantRelease(tenant);
    await owner.query('BEGIN');
    try {
      await owner.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenant.id]);
      await owner.query(`SELECT set_config('app.user_id',$1,true)`, [tenant.admin.id]);
      await expect(owner.query(
        `UPDATE ai_releases SET name=name || '-tampered' WHERE tenant_id=$1 AND id=$2`,
        [tenant.id, local.id],
      )).rejects.toThrow(/immutable/i);
    } finally {
      await owner.query('ROLLBACK');
    }

    await owner.query('BEGIN');
    try {
      await owner.query(`SELECT set_config('app.is_platform_admin','true',true)`);
      await expect(owner.query(
        `UPDATE ai_shared_releases SET name=name || '-tampered' WHERE id=$1`,
        [sharedReleaseId],
      )).rejects.toThrow(/immutable/i);
    } finally {
      await owner.query('ROLLBACK');
    }

    const activation = await repository(asIdentity(tenant, tenant.admin)).aiConfig.getActivation();
    await repository(asIdentity(tenant, tenant.admin)).aiConfig.activate({
      releaseId: local.id,
      expectedActivationVersion: activation!.version,
    });
    await expect(repository(asIdentity(tenant, tenant.admin)).aiConfig.retireRelease({
      releaseId: local.id,
      expectedVersion: local.draftVersion,
    })).rejects.toThrow(/active release|replaced|immutable/i);
  });

  it('isolates member trace reads while tenant admins can inspect own-tenant rows', async () => {
    const tenant = tenants[0];
    const ownerConversation = await newPinnedConversation(tenant, tenant.member);
    const ownerRepo = repository(asIdentity(tenant, tenant.member));
    const claim = await ownerRepo.aiTurns.claimTurn({
      conversationId: ownerConversation,
      requestId: randomUUID() as UUID,
      inputContent: 'mensaje sintético del miembro',
    });
    expect(claim.kind).toBe('acquired');
    if (claim.kind !== 'acquired') return;
    await ownerRepo.aiTurns.ensureUserMessage({ turnId: claim.turn.id, ownerToken: claim.ownerToken, conversationId: ownerConversation, content: 'mensaje sintético del miembro' });

    const otherMemberRepo = repository(asIdentity(tenant, platformUser)).aiTurns;
    expect(await otherMemberRepo.getTurn(claim.turn.id)).toBeUndefined();
    await expect(otherMemberRepo.adminListTurns({ conversationId: ownerConversation })).rejects.toThrow(/permisos|admin/i);
    const adminRepo = repository(asIdentity(tenant, tenant.admin)).aiTurns;
    expect(await adminRepo.adminListTurns({ conversationId: ownerConversation })).toHaveLength(1);
    await expect(adminRepo.adminDeleteTraceContent(claim.turn.id)).rejects.toThrow(/active or recoverable/i);
    await expect(withTenantTransaction({ id: tenant.id }, { id: tenant.admin.id }, (tx) =>
      tx.query(`UPDATE ai_turns SET input_hash=$3 WHERE tenant_id=$1 AND id=$2`, [tenant.id, claim.turn.id, 'a'.repeat(64)]),
    )).rejects.toThrow();
    const attemptId = await ownerRepo.aiTurns.startAttempt({
      turnId: claim.turn.id,
      ownerToken: claim.ownerToken,
      purpose: 'extractor',
      primaryProfileId: 'primary',
      effectiveProfileId: 'primary',
      provider: 'openrouter',
      model: 'fake/test',
    });
    await ownerRepo.aiTurns.attachAttemptRequest({ attemptId, turnId: claim.turn.id, ownerToken: claim.ownerToken, requestContent: 'prompt privado' });
    await expect(withTenantTransaction({ id: tenant.id }, { id: tenant.admin.id }, (tx) =>
      tx.query(`UPDATE ai_turn_attempts SET input_tokens=999 WHERE tenant_id=$1 AND turn_id=$2`, [tenant.id, claim.turn.id]),
    )).rejects.toThrow();
    await ownerRepo.aiTurns.finishAttempt({ attemptId, turnId: claim.turn.id, ownerToken: claim.ownerToken, outcome: 'succeeded', usage: { promptTokens: 3, completionTokens: 4 }, cost: null });

    await ownerRepo.aiTurns.completeTurn({ turnId: claim.turn.id, ownerToken: claim.ownerToken, responseContent: 'respuesta privada' });
    expect(await adminRepo.adminDeleteTraceContent(claim.turn.id)).toBe(true);
    const scrubbed = await ownerRepo.aiTurns.getTurn(claim.turn.id);
    expect(scrubbed).toMatchObject({ inputContent: null, responseContent: null, requestId: claim.turn.requestId, inputHash: claim.turn.inputHash });
    expect(await adminRepo.adminListAttempts(claim.turn.id)).toMatchObject([
      { requestContent: null, inputTokens: 3, outputTokens: 4, costAmount: null },
    ]);
  });

  it('claims idempotent requests, checks input hashes, and recovers only safe checkpoints', async () => {
    const tenant = tenants[0];
    const conversation = await newPinnedConversation(tenant, tenant.admin);
    const requestId = randomUUID() as UUID;
    const repo = repository(asIdentity(tenant, tenant.admin)).aiTurns;
    const parallel = await Promise.all([
      repo.claimTurn({ conversationId: conversation, requestId, inputContent: 'mensaje de carrera' }),
      repo.claimTurn({ conversationId: conversation, requestId, inputContent: 'mensaje de carrera' }),
    ]);
    expect(parallel.filter((result) => result.kind === 'acquired')).toHaveLength(1);
    expect(parallel.some((result) => result.kind === 'in_progress')).toBe(true);
    const acquired = parallel.find((result) => result.kind === 'acquired');
    if (!acquired || acquired.kind !== 'acquired') return;
    expect(await repo.claimTurn({ conversationId: conversation, requestId, inputContent: 'otro mensaje' })).toMatchObject({ kind: 'conflict' });

    await repo.checkpointTurn({ turnId: acquired.turn.id, ownerToken: acquired.ownerToken, expectedVersion: acquired.turn.version, stage: 'extracted', payload: { delta: { fields: {} } } });
    await owner.query(`UPDATE ai_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [acquired.turn.id]);
    const recovered = await repo.claimTurn({ conversationId: conversation, requestId, inputContent: 'mensaje de carrera' });
    expect(recovered).toMatchObject({ kind: 'acquired', turn: { stage: 'extracted' } });
    if (recovered.kind !== 'acquired') return;
    const effectsCommitted = await repo.checkpointTurn({ turnId: recovered.turn.id, ownerToken: recovered.ownerToken, expectedVersion: recovered.turn.version, stage: 'effects_committed', payload: { decisions: [] } });
    await owner.query(`UPDATE ai_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [effectsCommitted.id]);
    expect(await repo.claimTurn({ conversationId: conversation, requestId, inputContent: 'mensaje de carrera' }))
      .toMatchObject({ kind: 'acquired', turn: { stage: 'effects_committed' } });
  });

  it('marks expired effects_started and started-provider attempts uncertain without replay', async () => {
    const tenant = tenants[0];
    const conversation = await newPinnedConversation(tenant, tenant.admin);
    const repo = repository(asIdentity(tenant, tenant.admin)).aiTurns;
    const requestId = randomUUID() as UUID;
    const claim = await repo.claimTurn({ conversationId: conversation, requestId, inputContent: 'efecto incierto' });
    expect(claim.kind).toBe('acquired');
    if (claim.kind !== 'acquired') return;
    const extracted = await repo.checkpointTurn({ turnId: claim.turn.id, ownerToken: claim.ownerToken, expectedVersion: claim.turn.version, stage: 'extracted', payload: {} });
    await repo.checkpointTurn({ turnId: claim.turn.id, ownerToken: claim.ownerToken, expectedVersion: extracted.version, stage: 'effects_started', payload: {} });
    await owner.query(`UPDATE ai_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [claim.turn.id]);
    expect(await repo.claimTurn({ conversationId: conversation, requestId, inputContent: 'efecto incierto' })).toMatchObject({ kind: 'uncertain', turn: { stage: 'uncertain' } });

    const providerRequest = randomUUID() as UUID;
    const providerClaim = await repo.claimTurn({ conversationId: conversation, requestId: providerRequest, inputContent: 'intento incierto' });
    expect(providerClaim.kind).toBe('acquired');
    if (providerClaim.kind !== 'acquired') return;
    await repo.startAttempt({ turnId: providerClaim.turn.id, ownerToken: providerClaim.ownerToken, purpose: 'extractor', primaryProfileId: 'openrouter-extractor', effectiveProfileId: 'openrouter-extractor', provider: 'openrouter', model: 'fake/test' });
    await owner.query(`UPDATE ai_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [providerClaim.turn.id]);
    expect(await repo.claimTurn({ conversationId: conversation, requestId: providerRequest, inputContent: 'intento incierto' })).toMatchObject({ kind: 'uncertain' });
  });

  it('records ordered attempt limits, nullable usage/cost, request traces, and atomic response messages', async () => {
    const tenant = tenants[0];
    const conversation = await newPinnedConversation(tenant, tenant.admin);
    const repo = repository(asIdentity(tenant, tenant.admin)).aiTurns;
    const claim = await repo.claimTurn({ conversationId: conversation, requestId: randomUUID() as UUID, inputContent: 'guardar trazas' });
    expect(claim.kind).toBe('acquired');
    if (claim.kind !== 'acquired') return;
    const attempt1 = await repo.startAttempt({ turnId: claim.turn.id, ownerToken: claim.ownerToken, purpose: 'extractor', primaryProfileId: 'primary', effectiveProfileId: 'primary', provider: 'openrouter', model: 'fake/one' });
    await repo.attachAttemptRequest({ attemptId: attempt1, turnId: claim.turn.id, ownerToken: claim.ownerToken, requestContent: 'prompt synthetic' });
    await repo.finishAttempt({ attemptId: attempt1, turnId: claim.turn.id, ownerToken: claim.ownerToken, outcome: 'failed', failureCategory: 'provider_unavailable', usage: { promptTokens: null, completionTokens: null }, cost: null });
    const attempt2 = await repo.startAttempt({ turnId: claim.turn.id, ownerToken: claim.ownerToken, purpose: 'extractor', primaryProfileId: 'primary', effectiveProfileId: 'fallback', provider: 'anthropic', model: 'fake/two' });
    await repo.finishAttempt({ attemptId: attempt2, turnId: claim.turn.id, ownerToken: claim.ownerToken, outcome: 'succeeded', responseContent: 'respuesta sintética', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 }, cost: null });
    await expect(repo.startAttempt({ turnId: claim.turn.id, ownerToken: claim.ownerToken, purpose: 'extractor', primaryProfileId: 'primary', effectiveProfileId: 'third', provider: 'openrouter', model: 'fake/three' })).rejects.toThrow(/máximo|attempt/i);

    const attempts = await repo.listAttempts({ turnId: claim.turn.id, purpose: 'extractor' });
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(attempts[0]).toMatchObject({ status: 'failed', requestContent: 'prompt synthetic', inputTokens: null, outputTokens: null, costAmount: null });
    expect(attempts[1]).toMatchObject({ status: 'succeeded', inputTokens: 5, outputTokens: 7, costAmount: null });
    expect(await repo.getUsage()).toMatchObject({ attempts: 2, unknownCostAttempts: 2, knownCost: 0 });

    await repo.ensureUserMessage({ turnId: claim.turn.id, ownerToken: claim.ownerToken, conversationId: conversation, content: 'guardar trazas' });
    const completed = await repo.completeTurn({ turnId: claim.turn.id, ownerToken: claim.ownerToken, responseContent: 'respuesta durable' });
    expect(completed.turn.stage).toBe('responded');
    const messages = await withTenantTransaction({ id: tenant.id }, { id: tenant.admin.id }, (tx) =>
      tx.query<{ role: string }>(`SELECT role FROM messages WHERE tenant_id=$1 AND ai_turn_id=$2 ORDER BY role`, [tenant.id, claim.turn.id]),
    );
    expect(messages.rows.map((message) => message.role).sort()).toEqual(['assistant', 'user']);
    expect(await repo.claimTurn({ conversationId: conversation, requestId: claim.turn.requestId, inputContent: 'guardar trazas' })).toMatchObject({ kind: 'completed', turn: { responseContent: 'respuesta durable' } });
  });

  it('atomically stores task artifacts/status/outbox once and isolates trace deletion from replay', async () => {
    const tenant = tenants[0];
    const conversation = await newPinnedConversation(tenant, tenant.admin);
    const scoped = repository(asIdentity(tenant, tenant.admin));
    const task = await scoped.agentTasks.insertRoot({ conversationId: conversation, agentId: 'logo-agent', agentCardVersion: '0.1.0', idempotencyKey: randomUUID() as UUID, requirementsSnapshot: { business_name: 'synthetic' } });
    const claimedTask = await scoped.agentTasks.claimById(task.id as TaskId);
    expect(claimedTask?.status).toBe('in_progress');
    const settlement = {
      conversationId: conversation,
      taskId: task.id as TaskId,
      state: 'completed' as const,
      deliverableKind: 'logo' as const,
      artifacts: [{ kind: 'image', url: 'https://example.invalid/synthetic.png' }],
    };
    const first = await scoped.aiTurns.settleTaskAndEnqueue(settlement);
    const second = await scoped.aiTurns.settleTaskAndEnqueue(settlement);
    expect(second.deliverableIds).toEqual(first.deliverableIds);
    expect(await scoped.deliverables.listByAgentTask(task.id as TaskId)).toHaveLength(1);
    const outbox = await scoped.aiTurns.peekEvents({ conversationId: conversation });
    expect(outbox.filter((event) => event.eventId === `${task.id}:announce_completion`)).toHaveLength(1);

    const turn = await scoped.aiTurns.claimTurn({ conversationId: conversation, requestId: randomUUID() as UUID, inputContent: 'retención sintética' });
    expect(turn.kind).toBe('acquired');
    if (turn.kind !== 'acquired') return;
    await scoped.aiTurns.ensureUserMessage({ turnId: turn.turn.id, ownerToken: turn.ownerToken, conversationId: conversation, content: 'retención sintética' });
    await scoped.aiTurns.checkpointTurn({ turnId: turn.turn.id, ownerToken: turn.ownerToken, expectedVersion: turn.turn.version, stage: 'extracted', payload: { delta: { fields: {} } } });
    await scoped.aiTurns.completeTurn({ turnId: turn.turn.id, ownerToken: turn.ownerToken, responseContent: 'respuesta de prueba' });
    expect(await scoped.aiTurns.deleteTraceContent(turn.turn.id)).toBe(true);
    const deleted = await scoped.aiTurns.getTurn(turn.turn.id);
    expect(deleted).toMatchObject({ requestId: turn.turn.requestId, inputContent: null, responseContent: null, payload: {} });
    expect(await scoped.aiTurns.claimTurn({ conversationId: conversation, requestId: turn.turn.requestId, inputContent: 'retención sintética' })).toMatchObject({ kind: 'conflict' });
    expect((await scoped.aiTurns.peekEvents({ conversationId: conversation })).find((event) => event.eventId === `${task.id}:announce_completion`)?.payload.artifacts).toBeUndefined();
  });
});
