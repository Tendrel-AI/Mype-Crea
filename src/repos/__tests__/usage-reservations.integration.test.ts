/**
 * KAN-43 (SYS-08): the usage ledger against a disposable PostgreSQL database, with a fake
 * provider. Proves that parallel calls cannot overspend (tenant budget, hourly LLM calls,
 * daily images), that a denied call never reaches the provider, that settlement reconciles
 * the real cost, and tenant isolation. DATABASE_URL (owner) only seeds and inspects rows;
 * every product path runs as app_user. Refuses to run unless both URLs point at the same
 * database whose name ends in _ci or _test. Do not run against .env.local or shared databases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { repos, type Tenant, type User } from '..';
import { runWithUsage, UsageLimitError } from '../../services/usage/gateway';
import { USAGE_POLICY, type UsageKind } from '../../services/usage/policy';

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) {
    throw new Error('Usage integration tests require one disposable database ending in _ci or _test');
  }
  if (owner.hostname !== app.hostname || owner.port !== app.port) {
    throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  }
  if (owner.username === 'app_user' || app.username !== 'app_user') {
    throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
  }
}

SUITE('KAN-43 usage reservations (integration)', () => {
  let owner: pg.Client;

  async function createTenant(): Promise<{ tenant: Tenant; member: User; other: User; admin: User }> {
    const tenantId = randomUUID();
    await owner.query(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [tenantId, `KAN-43 ${tenantId}`]);
    const mk = async (role: 'admin' | 'member'): Promise<User> => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
        [id, tenantId, `kan43-${id}`, `${id}@example.invalid`, role],
      );
      return { id };
    };
    return { tenant: { id: tenantId }, member: await mk('member'), other: await mk('member'), admin: await mk('admin') };
  }

  /** Credits the tenant holds, inserted by the owner (the product path is the `/platform` recharge). */
  async function seedCredits(tenant: Tenant, usd: number): Promise<void> {
    await owner.query(
      `INSERT INTO tenant_credit_entries (tenant_id, kind, amount_usd, source, idempotency_key, actor_workos_user_id)
       VALUES ($1, 'recharge', $2, 'manual', $3, 'seed')`,
      [tenant.id, usd, `seed:${randomUUID()}`],
    );
  }

  const adminActor = (admin: User) => ({ workosUserId: `kan43-${admin.id}`, platformAdmin: false, tenantRole: 'admin' as const });

  async function statusCounts(tenant: Tenant): Promise<Record<string, number>> {
    const res = await owner.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM usage_reservations WHERE tenant_id = $1 AND pricing_version <> 'seed' GROUP BY status`,
      [tenant.id],
    );
    return Object.fromEntries(res.rows.map((r) => [r.status, r.n]));
  }

  /** N parallel gated calls through the real ledger; returns how often the fake provider ran. */
  async function parallelCalls(tenant: Tenant, user: User, n: number, kind: UsageKind, estimatedCostUsd: number) {
    let providerCalls = 0;
    const ledger = repos(tenant, user).usage;
    const results = await Promise.allSettled(
      Array.from({ length: n }, () =>
        runWithUsage(ledger, {
          request: { kind, estimatedCostUsd, provider: 'fake', model: 'fake-model' },
          call: async () => {
            providerCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return 'ok';
          },
          actualCost: () => ({ usd: estimatedCostUsd, source: 'estimate' }),
          failureCostUsd: () => estimatedCostUsd,
        }),
      ),
    );
    const denials = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    for (const denial of denials) expect(denial).toBeInstanceOf(UsageLimitError);
    return { providerCalls, denials: denials as UsageLimitError[] };
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

  it('schema: RLS forced, no DELETE and no write to created_at for app_user', async () => {
    const rls = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'usage_reservations'`,
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const privileges = await owner.query<{ del: boolean; ins_created: boolean; upd_created: boolean; upd_estimate: boolean }>(
      `SELECT has_table_privilege('app_user', 'usage_reservations', 'DELETE') AS del,
              has_column_privilege('app_user', 'usage_reservations', 'created_at', 'INSERT') AS ins_created,
              has_column_privilege('app_user', 'usage_reservations', 'created_at', 'UPDATE') AS upd_created,
              has_column_privilege('app_user', 'usage_reservations', 'estimated_cost_usd', 'UPDATE') AS upd_estimate`,
    );
    expect(privileges.rows[0]).toEqual({ del: false, ins_created: false, upd_created: false, upd_estimate: false });
  });

  it('concurrency: 20 parallel calls near the budget run the provider exactly as often as the budget allows', async () => {
    const t = await createTenant();
    await seedCredits(t.tenant, 1);
    const { providerCalls, denials } = await parallelCalls(t.tenant, t.member, 20, 'llm', 0.25);
    expect(providerCalls).toBe(4);
    expect(denials).toHaveLength(16);
    expect(new Set(denials.map((d) => d.reason))).toEqual(new Set(['tenant_credits']));
    expect(await statusCounts(t.tenant)).toEqual({ settled: 4, denied: 16 });
    const summary = await repos(t.tenant, t.admin, adminActor(t.admin)).aiTurns.adminGetUsage();
    expect(summary.budgetStatus).toMatchObject({ state: 'exhausted', balanceUsd: 0, reservedUsd: 0, availableUsd: 0 });
  });

  it('concurrency: 20 parallel images for one user stop at the daily limit of 15', async () => {
    const t = await createTenant();
    await seedCredits(t.tenant, 10);
    const { providerCalls, denials } = await parallelCalls(t.tenant, t.member, 20, 'image', 0.08);
    expect(providerCalls).toBe(USAGE_POLICY.userImagesPerDay);
    expect(denials.map((d) => d.reason)).toEqual(Array(5).fill('user_image_daily'));
    // The limit is per user: a colleague still has room.
    expect((await repos(t.tenant, t.other).usage.reserve({ kind: 'image', estimatedCostUsd: 0.08 })).allowed).toBe(true);
  });

  it('concurrency: 65 parallel LLM calls for one user stop at the hourly limit of 60', async () => {
    const t = await createTenant();
    await seedCredits(t.tenant, 10);
    const { providerCalls, denials } = await parallelCalls(t.tenant, t.member, 65, 'llm', 0.001);
    expect(providerCalls).toBe(USAGE_POLICY.userLlmCallsPerHour);
    expect(denials.map((d) => d.reason)).toEqual(Array(5).fill('user_llm_hourly'));
  });

  it('reconciles: a failed call settles at its failure cost, once, and only by its owner', async () => {
    const t = await createTenant();
    await seedCredits(t.tenant, 30);
    const ledger = repos(t.tenant, t.member).usage;
    await expect(
      runWithUsage(ledger, {
        request: { kind: 'llm', estimatedCostUsd: 0.5 },
        call: async () => { throw new Error('provider rejected'); },
        actualCost: () => ({ usd: 0.5, source: 'estimate' }),
        failureCostUsd: () => 0,
      }),
    ).rejects.toThrow('provider rejected');
    const row = await owner.query<{ id: string; status: string; actual_cost_usd: string; outcome: string }>(
      `SELECT id, status, actual_cost_usd, outcome FROM usage_reservations WHERE tenant_id = $1`,
      [t.tenant.id],
    );
    expect(row.rows[0]).toMatchObject({ status: 'settled', actual_cost_usd: '0.000000', outcome: 'failed' });
    expect(await ledger.settle({ reservationId: row.rows[0].id, actualCostUsd: 9, costSource: 'estimate', outcome: 'succeeded' })).toBe(false);

    const held = await ledger.reserve({ kind: 'llm', estimatedCostUsd: 0.1 });
    expect(held.allowed).toBe(true);
    // Another member of the same tenant cannot settle it (RLS: own rows only).
    expect(await repos(t.tenant, t.other).usage.settle({ reservationId: held.reservationId!, actualCostUsd: 0, costSource: 'estimate', outcome: 'succeeded' })).toBe(false);
    expect(await ledger.settle({ reservationId: held.reservationId!, actualCostUsd: 0.04, costSource: 'estimate', outcome: 'succeeded' })).toBe(true);
    const summary = await repos(t.tenant, t.admin, adminActor(t.admin)).aiTurns.adminGetUsage();
    expect(summary.budgetStatus).toMatchObject({ state: 'within_budget', balanceUsd: 29.96, reservedUsd: 0, availableUsd: 29.96 });
    // The settlement wrote exactly one consumption entry (idempotent on the reservation).
    const entries = await owner.query(`SELECT amount_usd::text FROM tenant_credit_entries WHERE tenant_id = $1 AND kind = 'consumption'`, [t.tenant.id]);
    expect(entries.rows).toEqual([{ amount_usd: '-0.040000' }]);
  });

  it('preflight writes nothing when allowed and records a denial when not', async () => {
    const t = await createTenant();
    await seedCredits(t.tenant, 1);
    const ledger = repos(t.tenant, t.member).usage;
    expect(await ledger.preflight({ kind: 'llm', calls: 2, estimatedCostUsd: 0, inputChars: 10 })).toEqual({ allowed: true, reservationId: null });
    expect(await statusCounts(t.tenant)).toEqual({});
    const denied = await ledger.preflight({ kind: 'llm', calls: 2, estimatedCostUsd: 0, inputChars: 4001 });
    expect(denied).toMatchObject({ allowed: false, reason: 'input_too_long' });
    expect(await statusCounts(t.tenant)).toEqual({ denied: 1 });
  });

  it('D52: an inactive user is refused with user_inactive and never reaches the provider', async () => {
    const t = await createTenant();
    await seedCredits(t.tenant, 10);
    await owner.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [t.member.id]);
    const { providerCalls, denials } = await parallelCalls(t.tenant, t.member, 3, 'llm', 0.01);
    expect(providerCalls).toBe(0);
    expect(denials.map((d) => d.reason)).toEqual(Array(3).fill('user_inactive'));
    expect(await statusCounts(t.tenant)).toEqual({ denied: 3 });
    // Another active user of the same tenant is unaffected.
    expect((await repos(t.tenant, t.other).usage.reserve({ kind: 'llm', estimatedCostUsd: 0.01 })).allowed).toBe(true);
  });

  it('isolation: one tenant without credits neither blocks nor exposes another tenant', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await seedCredits(b.tenant, 1);
    expect(await repos(a.tenant, a.member).usage.reserve({ kind: 'llm', estimatedCostUsd: 0.01 })).toMatchObject({ allowed: false, reason: 'tenant_credits' });
    expect((await repos(b.tenant, b.member).usage.reserve({ kind: 'llm', estimatedCostUsd: 0.01 })).allowed).toBe(true);
    const visible = await getPool().connect();
    try {
      await visible.query('BEGIN');
      await visible.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [b.tenant.id, b.member.id]);
      const rows = await visible.query(`SELECT tenant_id FROM usage_reservations WHERE tenant_id = $1`, [a.tenant.id]);
      expect(rows.rowCount).toBe(0);
      // Cannot write a row into another tenant either.
      await expect(
        visible.query(
          `INSERT INTO usage_reservations (tenant_id, user_id, kind, status, estimated_cost_usd, pricing_version) VALUES ($1, $2, 'llm', 'reserved', 0, 'x')`,
          [a.tenant.id, a.member.id],
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await visible.query('ROLLBACK');
      visible.release();
    }
  });
});
