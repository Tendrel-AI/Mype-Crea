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
import { withGlobalTransaction } from '../../db/global-transaction';
import { repos, systemRepos } from '..';
import { assertActivePlatformActor } from '../global-audit';
import { createBaselineDraft } from '../../services/ai-config/baseline';
import { AiConfigService } from '../../services/ai-config/service';
import { canonicalizeManifestJson, freezeManifest, type AiConfigManifestV1, type JsonValue } from '../../services/ai-config/manifest';
import type { ConversationId, TaskId, UUID } from '../../core/contracts';
import { parseNotification } from '../../core/contracts/notifications';
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
  const tenantIds: UUID[] = [];
  const sharedActors: string[] = [];
  const moduleVersions: number[] = [];

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

    platformUser = { id: tenantId(), workosUserId: workosId(), role: 'member' };
    const a = createTenantFixture();
    const b = createTenantFixture();
    tenants = [a, b];
    tenantIds.push(a.id, b.id);
    sharedActors.push(platformUser.workosUserId);

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
    await owner.query(
      `INSERT INTO platform_superadmins(workos_user_id, granted_by_workos_user_id, grant_source)
       VALUES($1, $1, 'authorized')`, [platformUser.workosUserId],
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
    if (owner && tenantIds.length) {
      await owner.query('BEGIN');
      try {
        // Test-only teardown bypasses append-only/immutability triggers on this connection only.
        // IDs are the random tenant/user fixtures created by this suite; no pilot rows are touched.
        await owner.query(`SET LOCAL session_replication_role = 'replica'`);
        if (sharedActors.length) await owner.query(`DELETE FROM platform_superadmins WHERE workos_user_id = ANY($1::text[])`, [sharedActors]);
        await owner.query(`DELETE FROM platform_module_assignments WHERE organization_id = ANY($1::uuid[])`, [tenantIds]);
        if (moduleVersions.length) {
          await owner.query(`DELETE FROM platform_module_defaults WHERE module_id = 'ai' AND version = ANY($1::int[])`, [moduleVersions]);
          await owner.query(`DELETE FROM platform_module_versions WHERE module_id = 'ai' AND version = ANY($1::int[])`, [moduleVersions]);
        }
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

    await owner.query(`UPDATE platform_superadmins SET revoked_at=now(), revoked_by_workos_user_id=$1 WHERE workos_user_id=$1`, [platformUser.workosUserId]);
    try {
      await expect(platformRepo.createSharedDraft({ name: `${TEST_PREFIX}revoked-platform-actor`, manifest: baseline, allowedOverridePaths: [] }))
        .rejects.toThrow(/permisos/i);
    } finally {
      await owner.query(`UPDATE platform_superadmins SET revoked_at=NULL, revoked_by_workos_user_id=NULL WHERE workos_user_id=$1`, [platformUser.workosUserId]);
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
    const primaryExtractorProfileId = baseline.fallback.extractor.primaryProfileId;
    const primaryExtractorProfile = baseline.models.find((profile) => profile.id === primaryExtractorProfileId)!;
    const attemptId = await ownerRepo.aiTurns.startAttempt({
      turnId: claim.turn.id,
      ownerToken: claim.ownerToken,
      purpose: 'extractor',
      primaryProfileId: primaryExtractorProfileId,
      effectiveProfileId: primaryExtractorProfileId,
      provider: primaryExtractorProfile.provider,
      model: 'fake/test',
    });
    await ownerRepo.aiTurns.attachAttemptRequest({ attemptId, turnId: claim.turn.id, ownerToken: claim.ownerToken, requestContent: 'prompt privado' });
    await expect(withTenantTransaction({ id: tenant.id }, { id: tenant.admin.id }, (tx) =>
      tx.query(`UPDATE ai_turn_attempts SET input_tokens=999 WHERE tenant_id=$1 AND turn_id=$2`, [tenant.id, claim.turn.id]),
    )).rejects.toThrow();
    await ownerRepo.aiTurns.finishAttempt({ attemptId, turnId: claim.turn.id, ownerToken: claim.ownerToken, outcome: 'succeeded', usage: { promptTokens: 3, completionTokens: 4 }, cost: null });

    // Follow the stage machine enforced by app.guard_turn_transition before completing.
    const extracted = await ownerRepo.aiTurns.checkpointTurn({ turnId: claim.turn.id, ownerToken: claim.ownerToken, expectedVersion: claim.turn.version, stage: 'extracted', payload: { delta: { fields: {} } } });
    await ownerRepo.aiTurns.checkpointTurn({ turnId: claim.turn.id, ownerToken: claim.ownerToken, expectedVersion: extracted.version, stage: 'effects_committed', payload: { decisions: [] } });
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
    // A different request while this turn is open reports the open turn instead of a unique violation.
    expect(await repo.claimTurn({ conversationId: conversation, requestId: randomUUID() as UUID, inputContent: 'mensaje paralelo' }))
      .toMatchObject({ kind: 'in_progress', turn: { id: acquired.turn.id } });
    // Repeat the duplicate-request race on fresh conversations: exactly one claimant, never an error.
    for (let round = 0; round < 5; round += 1) {
      const raceConversation = await newPinnedConversation(tenant, tenant.admin);
      const raceRequest = randomUUID() as UUID;
      const raced = await Promise.all([
        repo.claimTurn({ conversationId: raceConversation, requestId: raceRequest, inputContent: 'carrera repetida' }),
        repo.claimTurn({ conversationId: raceConversation, requestId: raceRequest, inputContent: 'carrera repetida' }),
        repo.claimTurn({ conversationId: raceConversation, requestId: randomUUID() as UUID, inputContent: 'otra solicitud' }),
      ]);
      expect(raced.filter((result) => result.kind === 'acquired')).toHaveLength(1);
      expect(raced.every((result) => ['acquired', 'in_progress'].includes(result.kind))).toBe(true);
    }

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

    // The prior uncertain turn intentionally remains recoverable and open. Use a second
    // synthetic conversation to exercise provider-attempt recovery independently.
    const providerConversation = await newPinnedConversation(tenant, tenant.admin);
    const providerRequest = randomUUID() as UUID;
    const providerClaim = await repo.claimTurn({ conversationId: providerConversation, requestId: providerRequest, inputContent: 'intento incierto' });
    expect(providerClaim.kind).toBe('acquired');
    if (providerClaim.kind !== 'acquired') return;
    const providerPrimaryProfileId = baseline.fallback.extractor.primaryProfileId;
    const providerPrimary = baseline.models.find((profile) => profile.id === providerPrimaryProfileId)!;
    await repo.startAttempt({ turnId: providerClaim.turn.id, ownerToken: providerClaim.ownerToken, purpose: 'extractor', primaryProfileId: providerPrimaryProfileId, effectiveProfileId: providerPrimaryProfileId, provider: providerPrimary.provider, model: 'fake/test' });
    await owner.query(`UPDATE ai_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [providerClaim.turn.id]);
    expect(await repo.claimTurn({ conversationId: providerConversation, requestId: providerRequest, inputContent: 'intento incierto' })).toMatchObject({ kind: 'uncertain' });
  });

  it('records ordered attempt limits, nullable usage/cost, request traces, and atomic response messages', async () => {
    const tenant = tenants[0];
    const conversation = await newPinnedConversation(tenant, tenant.admin);
    const repo = repository(asIdentity(tenant, tenant.admin)).aiTurns;
    // Earlier cases in this suite record attempts for the same user, so usage is asserted as a delta.
    const usageBefore = await repo.getUsage();
    const claim = await repo.claimTurn({ conversationId: conversation, requestId: randomUUID() as UUID, inputContent: 'guardar trazas' });
    expect(claim.kind).toBe('acquired');
    if (claim.kind !== 'acquired') return;
    const primaryProfileId = baseline.fallback.extractor.primaryProfileId;
    const fallbackProfileId = baseline.fallback.extractor.fallbackProfileIds[0];
    const primaryProfile = baseline.models.find((profile) => profile.id === primaryProfileId)!;
    const fallbackProfile = baseline.models.find((profile) => profile.id === fallbackProfileId)!;
    const attempt1 = await repo.startAttempt({ turnId: claim.turn.id, ownerToken: claim.ownerToken, purpose: 'extractor', primaryProfileId, effectiveProfileId: primaryProfileId, provider: primaryProfile.provider, model: 'fake/one' });
    await repo.attachAttemptRequest({ attemptId: attempt1, turnId: claim.turn.id, ownerToken: claim.ownerToken, requestContent: 'prompt synthetic' });
    await repo.finishAttempt({ attemptId: attempt1, turnId: claim.turn.id, ownerToken: claim.ownerToken, outcome: 'failed', failureCategory: 'provider_unavailable', usage: { promptTokens: null, completionTokens: null }, cost: null });
    const attempt2 = await repo.startAttempt({ turnId: claim.turn.id, ownerToken: claim.ownerToken, purpose: 'extractor', primaryProfileId, effectiveProfileId: fallbackProfileId, provider: fallbackProfile.provider, model: 'fake/two' });
    await repo.finishAttempt({ attemptId: attempt2, turnId: claim.turn.id, ownerToken: claim.ownerToken, outcome: 'succeeded', responseContent: 'respuesta sintética', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 }, cost: null });
    // A third attempt is rejected by the two-attempt limit even when it names a configured profile.
    const thirdProfileId = baseline.fallback.extractor.fallbackProfileIds[1] ?? fallbackProfileId;
    const thirdProfile = baseline.models.find((profile) => profile.id === thirdProfileId)!;
    await expect(repo.startAttempt({ turnId: claim.turn.id, ownerToken: claim.ownerToken, purpose: 'extractor', primaryProfileId, effectiveProfileId: thirdProfileId, provider: thirdProfile.provider, model: 'fake/three' }))
      .rejects.toThrow(/excede la secuencia de respaldo/i);

    const attempts = await repo.listAttempts({ turnId: claim.turn.id, purpose: 'extractor' });
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(attempts[0]).toMatchObject({ status: 'failed', requestContent: 'prompt synthetic', inputTokens: null, outputTokens: null, costAmount: null });
    expect(attempts[1]).toMatchObject({ status: 'succeeded', inputTokens: 5, outputTokens: 7, costAmount: null });
    const usageAfter = await repo.getUsage();
    expect(usageAfter.attempts - usageBefore.attempts).toBe(2);
    expect(usageAfter.unknownCostAttempts - usageBefore.unknownCostAttempts).toBe(2);
    expect(usageAfter.knownCost).toBe(usageBefore.knownCost);
    expect(usageAfter.unknownInputTokenAttempts - usageBefore.unknownInputTokenAttempts).toBe(1);
    expect(usageAfter.costAccountingStatus).toBe('unknown');

    await repo.ensureUserMessage({ turnId: claim.turn.id, ownerToken: claim.ownerToken, conversationId: conversation, content: 'guardar trazas' });
    const extracted = await repo.checkpointTurn({ turnId: claim.turn.id, ownerToken: claim.ownerToken, expectedVersion: claim.turn.version, stage: 'extracted', payload: { delta: { fields: {} } } });
    await repo.checkpointTurn({ turnId: claim.turn.id, ownerToken: claim.ownerToken, expectedVersion: extracted.version, stage: 'effects_committed', payload: { decisions: [] } });
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
    // KAN-58: the outbox payload is a task_completed notification of the contract.
    const completedRow = outbox.find((event) => event.eventId === `${task.id}:announce_completion`)!;
    expect(completedRow.kind).toBe('artifact');
    expect(parseNotification(completedRow.payload, ['task_completed'])).toMatchObject({
      ok: true,
      notification: { kind: 'task_completed', taskId: task.id, agentId: 'logo-agent', deliverableIds: first.deliverableIds },
    });

    // A failed task gets one task_failed notice carrying the sanitized detail.
    const failedTask = await scoped.agentTasks.insertRoot({ conversationId: conversation, agentId: 'logo-agent', agentCardVersion: '0.1.0', idempotencyKey: randomUUID() as UUID, requirementsSnapshot: { business_name: 'synthetic' } });
    await scoped.agentTasks.claimById(failedTask.id as TaskId);
    const failedSettlement = {
      conversationId: conversation,
      taskId: failedTask.id as TaskId,
      state: 'failed' as const,
      deliverableKind: 'logo' as const,
      artifacts: [],
      error: { kind: 'content_policy', message: 'blocked\nby Bearer abc123 filter' },
      errorCategory: 'content_policy' as const,
    };
    await scoped.aiTurns.settleTaskAndEnqueue(failedSettlement);
    await scoped.aiTurns.settleTaskAndEnqueue(failedSettlement);
    const notices = (await scoped.aiTurns.peekEvents({ conversationId: conversation })).filter(
      (event) => event.eventId === `${failedTask.id}:announce_failure`,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('notice');
    expect(parseNotification(notices[0].payload, ['task_failed'])).toMatchObject({
      ok: true,
      notification: {
        kind: 'task_failed',
        taskId: failedTask.id,
        detail: { errorCategory: 'content_policy', errorKind: 'content_policy', message: 'blocked by Bearer [redacted] filter' },
      },
    });

    const turn = await scoped.aiTurns.claimTurn({ conversationId: conversation, requestId: randomUUID() as UUID, inputContent: 'retención sintética' });
    expect(turn.kind).toBe('acquired');
    if (turn.kind !== 'acquired') return;
    await scoped.aiTurns.ensureUserMessage({ turnId: turn.turn.id, ownerToken: turn.ownerToken, conversationId: conversation, content: 'retención sintética' });
    await scoped.aiTurns.checkpointTurn({ turnId: turn.turn.id, ownerToken: turn.ownerToken, expectedVersion: turn.turn.version, stage: 'extracted', payload: { delta: { fields: {} } } });
    const extracted = await scoped.aiTurns.getTurn(turn.turn.id);
    expect(extracted).toBeDefined();
    await scoped.aiTurns.checkpointTurn({ turnId: turn.turn.id, ownerToken: turn.ownerToken, expectedVersion: extracted!.version, stage: 'effects_committed', payload: { decisions: [] } });
    await scoped.aiTurns.completeTurn({ turnId: turn.turn.id, ownerToken: turn.ownerToken, responseContent: 'respuesta de prueba' });
    expect(await scoped.aiTurns.deleteTraceContent(turn.turn.id)).toBe(true);
    const deleted = await scoped.aiTurns.getTurn(turn.turn.id);
    expect(deleted).toMatchObject({ requestId: turn.turn.requestId, inputContent: null, responseContent: null, payload: {} });
    // Scrubbing keeps the request ID, input hash and stage, so a duplicate of the same request
    // stays completed without replaying the turn or restoring content; changed input still conflicts.
    expect(await scoped.aiTurns.claimTurn({ conversationId: conversation, requestId: turn.turn.requestId, inputContent: 'retención sintética' }))
      .toMatchObject({ kind: 'completed', turn: { id: turn.turn.id, stage: 'responded', inputContent: null, responseContent: null } });
    expect(await scoped.aiTurns.claimTurn({ conversationId: conversation, requestId: turn.turn.requestId, inputContent: 'otro contenido' }))
      .toMatchObject({ kind: 'conflict' });
    // The task outbox event is not linked to the scrubbed turn, so its artifact survives.
    expect((await scoped.aiTurns.peekEvents({ conversationId: conversation })).find((event) => event.eventId === `${task.id}:announce_completion`)?.payload.artifacts)
      .toEqual([expect.objectContaining({ kind: 'image', url: 'https://example.invalid/synthetic.png' })]);

    // Reconcile rebuilds missing notices with the same contract payloads.
    const before = new Map(
      (await scoped.aiTurns.peekEvents({ conversationId: conversation }))
        .filter((event) => event.eventId.startsWith(`${task.id}:`) || event.eventId.startsWith(`${failedTask.id}:`))
        .map((event) => [event.eventId, event.payload]),
    );
    expect(before.size).toBe(2);
    await owner.query(`DELETE FROM ai_turn_events WHERE tenant_id = $1 AND event_id = ANY($2::text[])`, [tenant.id, [...before.keys()]]);
    expect(await systemRepos({ id: tenant.id }).aiEvents!.reconcileSettledTasks()).toBeGreaterThanOrEqual(2);
    const rebuilt = new Map(
      (await scoped.aiTurns.peekEvents({ conversationId: conversation }))
        .filter((event) => before.has(event.eventId))
        .map((event) => [event.eventId, event.payload]),
    );
    const failureId = `${failedTask.id}:announce_failure`;
    const completionId = `${task.id}:announce_completion`;
    expect(rebuilt.get(failureId)).toEqual(before.get(failureId));
    // Known bug (docs/agents/known-bugs): a URL deliverable does not store its artifact kind,
    // so the rebuilt completion carries the deliverable kind instead. Everything else matches.
    expect(parseNotification(rebuilt.get(completionId), ['task_completed'])).toMatchObject({
      ok: true,
      notification: {
        deliverableIds: first.deliverableIds,
        artifacts: [{ url: 'https://example.invalid/synthetic.png' }],
      },
    });
  });

  it('locks shared releases only through the narrow helper without widening tenant or platform privileges', async () => {
    const [tenantA, tenantB] = tenants;
    const lockSql = `SELECT app.lock_frozen_shared_release($1) AS frozen`;
    const lockAs = (tenant: FixtureTenant, user: FixtureUser, id: string) =>
      withTenantTransaction({ id: tenant.id }, { id: user.id }, async (tx) =>
        (await tx.query<{ frozen: boolean }>(lockSql, [id])).rows[0]?.frozen);

    // Catalog posture: SECURITY DEFINER, fixed search_path, row security off, app_user only.
    const fn = await owner.query<{ prosecdef: boolean; proconfig: string[]; app_exec: boolean; public_exec: boolean }>(
      `SELECT p.prosecdef, p.proconfig,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'lock_frozen_shared_release'`,
    );
    expect(fn.rows).toHaveLength(1);
    expect(fn.rows[0]).toMatchObject({ prosecdef: true, app_exec: true, public_exec: false });
    expect(fn.rows[0]!.proconfig).toEqual(expect.arrayContaining(['search_path=pg_catalog, public, app, pg_temp', 'row_security=off']));

    // Tenant B still serves the initial shared clone from suite setup.
    const activationB = await repository(asIdentity(tenantB, tenantB.admin)).aiConfig.getActivation();
    const activeB = await repository(asIdentity(tenantB, tenantB.admin)).aiConfig.getRelease(activationB!.releaseId);
    expect(activeB?.baseSharedReleaseId).toBe(sharedReleaseId);
    const unrelated = await makeSharedRelease(baseline, `${TEST_PREFIX}unrelated-shared`);

    // A tenant admin may lock any frozen shared release (admins can already read the catalog)
    // but still cannot update or row-lock shared releases directly.
    expect(await lockAs(tenantB, tenantB.admin, unrelated.id)).toBe(true);
    await withTenantTransaction({ id: tenantB.id }, { id: tenantB.admin.id }, async (tx) => {
      const update = await tx.query(`UPDATE ai_shared_releases SET name = name || '-tenant-admin' WHERE id = $1`, [unrelated.id]);
      expect(update.rowCount).toBe(0);
      const directLock = await tx.query(`SELECT id FROM ai_shared_releases WHERE id = $1 FOR SHARE`, [unrelated.id]);
      expect(directLock.rowCount).toBe(0);
    });

    // An ordinary member gets true only for the shared base of the tenant's active release
    // (the conversation-pin path), false for anything else, and cannot read or update rows.
    expect(await lockAs(tenantB, tenantB.member, sharedReleaseId)).toBe(true);
    expect(await lockAs(tenantB, tenantB.member, unrelated.id)).toBe(false);
    await withTenantTransaction({ id: tenantB.id }, { id: tenantB.member.id }, async (tx) => {
      const read = await tx.query(`SELECT id FROM ai_shared_releases WHERE id = ANY($1::uuid[])`, [[unrelated.id, sharedReleaseId]]);
      expect(read.rowCount).toBe(0);
      const update = await tx.query(`UPDATE ai_shared_releases SET name = name || '-member' WHERE id = $1`, [sharedReleaseId]);
      expect(update.rowCount).toBe(0);
    });
    expect(await newPinnedConversation(tenantB, tenantB.member)).toBeTruthy();

    // Ordinary members cannot activate, through the repository or with raw SQL.
    const memberConfig = repository(asIdentity(tenantB, tenantB.member)).aiConfig;
    await expect(memberConfig.activate({ releaseId: activeB!.id, expectedActivationVersion: activationB!.version }))
      .rejects.toThrow(/permisos/i);
    await expect(withTenantTransaction({ id: tenantB.id }, { id: tenantB.member.id }, (tx) =>
      tx.query(`UPDATE ai_release_activations SET version = version + 1, updated_by = $2 WHERE tenant_id = $1`, [tenantB.id, tenantB.member.id]),
    )).rejects.toThrow();

    // Forged cross-tenant context: tenant A's member bound to tenant B reads and writes nothing.
    expect(await lockAs(tenantB, tenantA.member, sharedReleaseId)).toBe(false);
    await withTenantTransaction({ id: tenantB.id }, { id: tenantA.member.id }, async (tx) => {
      expect((await tx.query(`SELECT id FROM ai_releases WHERE tenant_id = $1`, [tenantB.id])).rowCount).toBe(0);
      expect((await tx.query(`UPDATE ai_release_activations SET updated_at = now() WHERE tenant_id = $1`, [tenantB.id])).rowCount).toBe(0);
    });
    await expect(withTenantTransaction({ id: tenantB.id }, { id: tenantA.member.id }, (tx) =>
      tx.query(`INSERT INTO ai_config_audit_events(tenant_id, actor_user_id, action) VALUES ($1, $2, 'forged')`, [tenantB.id, tenantA.member.id]),
    )).rejects.toThrow(/row-level security/i);

    // A validated platform actor sees no tenant content in the global context.
    const platformView = await withGlobalTransaction(async (tx) => {
      await assertActivePlatformActor(tx, platformUser.workosUserId);
      return tx.query<{ conversations: number; releases: number; turns: number; users: number }>(
        `SELECT (SELECT count(*) FROM conversations)::int AS conversations,
                (SELECT count(*) FROM ai_releases)::int AS releases,
                (SELECT count(*) FROM ai_turns)::int AS turns,
                (SELECT count(*) FROM users)::int AS users`,
      );
    });
    expect(platformView.rows[0]).toEqual({ conversations: 0, releases: 0, turns: 0, users: 0 });

    // Retirement waits behind the helper's row lock and proceeds once that transaction commits.
    const platformConfig = repository(asIdentity(tenantA, platformUser, true)).aiConfig;
    let retirement: Promise<unknown> | undefined;
    let settled = false;
    await withTenantTransaction({ id: tenantB.id }, { id: tenantB.admin.id }, async (tx) => {
      expect((await tx.query<{ frozen: boolean }>(lockSql, [unrelated.id])).rows[0]?.frozen).toBe(true);
      retirement = platformConfig.retireSharedRelease({ releaseId: unrelated.id, expectedVersion: unrelated.draftVersion })
        .finally(() => { settled = true; });
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const blocked = await owner.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%UPDATE ai_shared_releases%'`,
        );
        waiting = blocked.rows[0]?.waiting ?? 0;
      }
      expect(waiting).toBe(1);
      expect(settled).toBe(false);
    });
    await expect(retirement).resolves.toMatchObject({ id: unrelated.id, status: 'retired' });
    expect(await lockAs(tenantB, tenantB.admin, unrelated.id)).toBe(false);
  });

  it('pins new member conversations to the platform default or module assignment without widening tenant privileges (KAN-77)', async () => {
    // Tenant C has no local activation, so the global AI default applies to it.
    const tenantC = createTenantFixture();
    tenantIds.push(tenantC.id);
    await owner.query(
      `INSERT INTO tenants(id,kind,name,plan,workos_org_id) VALUES($1,'institutional',$2,'test',$3)`,
      [tenantC.id, `${TEST_PREFIX}${tenantC.id}`, tenantC.organizationId],
    );
    for (const user of [tenantC.admin, tenantC.member]) {
      await owner.query(
        `INSERT INTO users(id,tenant_id,workos_user_id,email,role,status) VALUES($1,$2,$3,$4,$5,'active')`,
        [user.id, tenantC.id, user.workosUserId, `${user.workosUserId}@example.invalid`, user.role],
      );
    }
    const defaultVariant = copyManifest(baseline);
    (defaultVariant.planner.thresholds as Record<string, JsonValue>)['kan77Default'] = 1;
    const assignedVariant = copyManifest(baseline);
    (assignedVariant.planner.thresholds as Record<string, JsonValue>)['kan77Assigned'] = 2;
    const defaultShared = await makeSharedRelease(defaultVariant, `${TEST_PREFIX}kan77-default`);
    const assignedShared = await makeSharedRelease(assignedVariant, `${TEST_PREFIX}kan77-assigned`);
    const unrelatedShared = await makeSharedRelease(baseline, `${TEST_PREFIX}kan77-unrelated`);

    // Synthetic platform configuration rows (fixture owner); every assertion below runs as app_user.
    const addModuleVersion = async (sharedId: string) => {
      const row = await owner.query<{ version: number }>(
        `INSERT INTO platform_module_versions(module_id, version, config, shared_release_id, created_by_workos_user_id)
         SELECT 'ai', COALESCE(max(version), 0) + 1, jsonb_build_object('sharedReleaseId', $1::text), $1::uuid, $2
           FROM platform_module_versions WHERE module_id = 'ai'
         RETURNING version`,
        [sharedId, platformUser.workosUserId],
      );
      moduleVersions.push(row.rows[0]!.version);
      return row.rows[0]!.version;
    };
    const defaultVersion = await addModuleVersion(defaultShared.id);
    const assignedVersion = await addModuleVersion(assignedShared.id);
    const previousDefault = await owner.query<{ version: number; updated_by_workos_user_id: string }>(
      `SELECT version, updated_by_workos_user_id FROM platform_module_defaults WHERE module_id = 'ai'`,
    );
    await owner.query(
      `INSERT INTO platform_module_defaults(module_id, version, updated_by_workos_user_id) VALUES ('ai', $1, $2)
       ON CONFLICT (module_id) DO UPDATE SET version = EXCLUDED.version, updated_by_workos_user_id = EXCLUDED.updated_by_workos_user_id`,
      [defaultVersion, platformUser.workosUserId],
    );

    const pinOf = async (tenant: FixtureTenant, user: FixtureUser, conversation: ConversationId) =>
      (await repository(asIdentity(tenant, user)).conversations.readPinnedConversation(conversation, []))?.releaseId;
    const releaseOf = async (releaseId: string) =>
      owner.query<{ tenant_id: string; base_shared_release_id: string | null; content_hash: string;
        status: string; is_platform_materialization: boolean; created_by: string }>(
        `SELECT tenant_id, base_shared_release_id, content_hash, status, is_platform_materialization, created_by
           FROM ai_releases WHERE id = $1`, [releaseId]);

    try {
      // 1. Global default, ordinary member, no local activation.
      const memberDefault = await newPinnedConversation(tenantC, tenantC.member);
      const defaultReleaseId = (await pinOf(tenantC, tenantC.member, memberDefault))!;
      expect((await releaseOf(defaultReleaseId)).rows[0]).toMatchObject({
        tenant_id: tenantC.id, base_shared_release_id: defaultShared.id, content_hash: defaultShared.contentHash,
        status: 'frozen', is_platform_materialization: true, created_by: tenantC.member.id,
      });
      // The admin's next conversation reuses the same tenant-local materialization.
      const adminDefault = await newPinnedConversation(tenantC, tenantC.admin);
      expect(await pinOf(tenantC, tenantC.admin, adminDefault)).toBe(defaultReleaseId);
      expect((await owner.query(`SELECT count(*)::int AS n FROM ai_releases WHERE tenant_id = $1`, [tenantC.id])).rows[0]).toEqual({ n: 1 });
      // Concurrent first conversations still share one materialization.
      await Promise.all([newPinnedConversation(tenantC, tenantC.member), newPinnedConversation(tenantC, tenantC.admin)]);
      expect((await owner.query(`SELECT count(*)::int AS n FROM ai_releases WHERE tenant_id = $1`, [tenantC.id])).rows[0]).toEqual({ n: 1 });

      // Members still cannot create or activate releases directly, nor read other shared releases.
      await withTenantTransaction({ id: tenantC.id }, { id: tenantC.member.id }, async (tx) => {
        expect((await tx.query(`SELECT id FROM ai_shared_releases WHERE id = $1`, [unrelatedShared.id])).rowCount).toBe(0);
      });
      await expect(withTenantTransaction({ id: tenantC.id }, { id: tenantC.member.id }, (tx) =>
        tx.query(
          `INSERT INTO ai_releases(tenant_id, name, status, manifest, canonical_content, content_hash,
             base_shared_release_id, is_platform_materialization, created_by, updated_by)
           SELECT tenant_id, name || '-forged', status, manifest, canonical_content, content_hash,
             $2, false, $3, $3 FROM ai_releases WHERE id = $1`,
          [defaultReleaseId, unrelatedShared.id, tenantC.member.id]),
      )).rejects.toThrow(/row-level security/i);
      await expect(withTenantTransaction({ id: tenantC.id }, { id: tenantC.member.id }, (tx) =>
        tx.query(`INSERT INTO ai_release_activations(tenant_id, release_id, version, updated_by) VALUES ($1, $2, 1, $3)`,
          [tenantC.id, defaultReleaseId, tenantC.member.id]),
      )).rejects.toThrow();
      await expect(repository(asIdentity(tenantC, tenantC.member)).aiConfig
        .activate({ releaseId: defaultReleaseId, expectedActivationVersion: 0 })).rejects.toThrow(/permisos/i);

      // New privileged helpers: SECURITY DEFINER, fixed config, executable by app_user only.
      const helpers = await owner.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; app_exec: boolean; public_exec: boolean }>(
        `SELECT p.proname, p.prosecdef, p.proconfig,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_exec,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname IN
            ('materialize_platform_ai_release', 'lock_effective_platform_ai_release', 'effective_platform_ai_shared_release')
          ORDER BY p.proname`,
      );
      expect(helpers.rows.map((row) => row.proname)).toEqual([
        'effective_platform_ai_shared_release', 'lock_effective_platform_ai_release', 'materialize_platform_ai_release',
      ]);
      for (const helper of helpers.rows) {
        expect(helper.public_exec).toBe(false);
        expect(helper.prosecdef).toBe(helper.proname !== 'effective_platform_ai_shared_release');
        // The internal resolver is reachable only from inside the definer helpers.
        expect(helper.app_exec).toBe(helper.proname !== 'effective_platform_ai_shared_release');
        if (helper.prosecdef) {
          expect(helper.proconfig).toEqual(expect.arrayContaining(['search_path=pg_catalog, public, app, pg_temp', 'row_security=off']));
        }
      }
      await expect(withTenantTransaction({ id: tenantC.id }, { id: tenantC.member.id }, (tx) =>
        tx.query(`SELECT app.effective_platform_ai_shared_release($1)`, [tenantC.id]),
      )).rejects.toThrow(/permission denied/i);

      // Helpers refuse anything but the tenant's effective platform release, and forged contexts.
      const helperAs = (tenant: FixtureTenant, user: FixtureUser, fn: string, id: string) =>
        withTenantTransaction({ id: tenant.id }, { id: user.id }, async (tx) =>
          (await tx.query<{ value: unknown }>(`SELECT app.${fn}($1) AS value`, [id])).rows[0]?.value);
      expect(await helperAs(tenantC, tenantC.member, 'materialize_platform_ai_release', unrelatedShared.id)).toBeNull();
      expect(await helperAs(tenantC, tenantC.member, 'lock_effective_platform_ai_release', unrelatedShared.id)).toBe(false);
      expect(await helperAs(tenantC, tenantC.member, 'lock_effective_platform_ai_release', defaultShared.id)).toBe(true);
      expect(await helperAs(tenantC, tenants[0].member, 'materialize_platform_ai_release', defaultShared.id)).toBeNull();
      expect(await helperAs(tenantC, tenants[0].member, 'lock_effective_platform_ai_release', defaultShared.id)).toBe(false);
      // Tenants with a local activation do not take the default; the helper refuses it there.
      expect(await helperAs(tenants[1], tenants[1].member, 'materialize_platform_ai_release', defaultShared.id)).toBeNull();
      expect((await owner.query(`SELECT count(*)::int AS n FROM ai_releases WHERE tenant_id = ANY($1::uuid[]) AND base_shared_release_id = $2`,
        [[tenants[0].id, tenants[1].id], defaultShared.id])).rows[0]).toEqual({ n: 0 });

      // Cross-tenant: another tenant's member cannot read or pin to tenant C's release.
      await withTenantTransaction({ id: tenants[0].id }, { id: tenants[0].member.id }, async (tx) => {
        expect((await tx.query(`SELECT id FROM ai_releases WHERE id = $1`, [defaultReleaseId])).rowCount).toBe(0);
        expect((await tx.query(`SELECT id FROM conversations WHERE id = $1`, [memberDefault])).rowCount).toBe(0);
      });
      await expect(withTenantTransaction({ id: tenants[0].id }, { id: tenants[0].member.id }, (tx) =>
        tx.query(`INSERT INTO conversations(id, tenant_id, user_id, ai_release_id, configuration_state) VALUES ($1, $2, $3, $4, 'pinned')`,
          [randomUUID(), tenants[0].id, tenants[0].member.id, defaultReleaseId]),
      )).rejects.toThrow();

      // 2. A local activation outranks the global default.
      const local = await makeTenantRelease(tenantC);
      await repository(asIdentity(tenantC, tenantC.admin)).aiConfig.activate({ releaseId: local.id, expectedActivationVersion: 0 });
      const memberLocal = await newPinnedConversation(tenantC, tenantC.member);
      expect(await pinOf(tenantC, tenantC.member, memberLocal)).toBe(local.id);
      // The default materialization is no longer effective, so a direct pin to it is rejected.
      await expect(withTenantTransaction({ id: tenantC.id }, { id: tenantC.member.id }, (tx) =>
        tx.query(`INSERT INTO conversations(id, tenant_id, user_id, ai_release_id, configuration_state) VALUES ($1, $2, $3, $4, 'pinned')`,
          [randomUUID(), tenantC.id, tenantC.member.id, defaultReleaseId]),
      )).rejects.toThrow(/frozen active tenant release/);

      // 3. A module assignment outranks the local activation.
      await owner.query(
        `INSERT INTO platform_module_assignments(module_id, organization_id, version, updated_by_workos_user_id) VALUES ('ai', $1, $2, $3)`,
        [tenantC.id, assignedVersion, platformUser.workosUserId],
      );
      const memberAssigned = await newPinnedConversation(tenantC, tenantC.member);
      const assignedReleaseId = (await pinOf(tenantC, tenantC.member, memberAssigned))!;
      expect(assignedReleaseId).not.toBe(local.id);
      expect((await releaseOf(assignedReleaseId)).rows[0]).toMatchObject({
        tenant_id: tenantC.id, base_shared_release_id: assignedShared.id, content_hash: assignedShared.contentHash,
        status: 'frozen', is_platform_materialization: true,
      });
      // Existing pins never move.
      expect(await pinOf(tenantC, tenantC.member, memberDefault)).toBe(defaultReleaseId);
      expect(await pinOf(tenantC, tenantC.member, memberLocal)).toBe(local.id);
      expect((await repository(asIdentity(tenantC, tenantC.member)).aiConfig.getActivation())?.releaseId).toBe(local.id);

      // 4. A retired effective shared release cannot be materialized or pinned.
      await repository(asIdentity(tenants[0], platformUser, true)).aiConfig
        .retireSharedRelease({ releaseId: assignedShared.id, expectedVersion: assignedShared.draftVersion });
      await expect(repository(asIdentity(tenantC, tenantC.member)).conversations.ensurePinnedConversation({
        conversationId: randomUUID() as ConversationId, schemas: [],
      })).rejects.toThrow(/ya no está disponible/);
      await expect(withTenantTransaction({ id: tenantC.id }, { id: tenantC.member.id }, (tx) =>
        tx.query(`INSERT INTO conversations(id, tenant_id, user_id, ai_release_id, configuration_state) VALUES ($1, $2, $3, $4, 'pinned')`,
          [randomUUID(), tenantC.id, tenantC.member.id, assignedReleaseId]),
      )).rejects.toThrow();
    } finally {
      await owner.query(`DELETE FROM platform_module_assignments WHERE organization_id = $1`, [tenantC.id]);
      if (previousDefault.rows[0]) {
        await owner.query(`UPDATE platform_module_defaults SET version = $1, updated_by_workos_user_id = $2 WHERE module_id = 'ai'`,
          [previousDefault.rows[0].version, previousDefault.rows[0].updated_by_workos_user_id]);
      } else {
        await owner.query(`DELETE FROM platform_module_defaults WHERE module_id = 'ai'`);
      }
    }
  });
});
