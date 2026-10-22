# KAN-77 database validation (2026-10-21)

- Worktree `/Users/matias/Desktop/Mypes-crea/worktrees/db`, branch `fix/kan-77-release-resolution`,
  base `bb3817c` (= `origin/developer`, 17 migrations through `1792378760000_shared-release-lock-helper`).
  Validated fix commit `d40e946`; new forward migration `1792640000000_platform-release-materialization`.
- Isolation: each run used a uniquely named `postgres:16-alpine` container (`kan77-validate-<ts>-<rand>`,
  `--rm`, data on `--tmpfs`, random `127.0.0.1` port, database `kan77_ci`, random owner and `app_user`
  passwords). `.env.local` was never loaded; no shared, dev, or Railway database was touched. All
  containers were stopped (and removed by `--rm`) at the end; no other container was touched.

## Reproduction (before the fix)

New case in `src/repos/__tests__/ai-config.integration.test.ts` (tenant with no local activation, ordinary
member, global `ai` default pointing at a frozen shared release). On `bb3817c` code and migrations it failed:
`La versión compartida de IA ya no está disponible.` at `resolveNewConversationRelease`
(`src/repos/conversations.ts:101`); the other 11 cases passed. A manual `SET ROLE app_user` probe on the
same disposable DB confirmed all three suspected causes: member plain SELECT of the default shared release
returned 1 row but `FOR SHARE` returned 0; a member INSERT into `ai_releases` failed the RLS `WITH CHECK`;
a tenant admin could insert the copy, but the pin was rejected with
`conversation pin must use the frozen active tenant release`.

## Commands (secrets elided)

```
docker run -d --rm --name kan77-validate-<ts>-<rand> -e POSTGRES_PASSWORD=<random> -e POSTGRES_DB=kan77_ci \
  --tmpfs /var/lib/postgresql/data -p 127.0.0.1::5432 postgres:16-alpine
export DATABASE_URL=postgres://postgres:<random>@127.0.0.1:<port>/kan77_ci
# upgrade only: apply and record origin/developer migrations first
git archive origin/developer migrations | tar -x -C <tmp> && npx node-pg-migrate up -m <tmp>/migrations
npx node-pg-migrate up
psql -c "ALTER ROLE app_user PASSWORD '<random>'"
export APP_DATABASE_URL=postgres://app_user:<random>@127.0.0.1:<port>/kan77_ci LANGSMITH_TRACING=false LOG_LEVEL=warn
node scripts/ci-db-check.mjs
npx vitest run src/repos/__tests__/ai-config.integration.test.ts \
  src/repos/__tests__/global-persistence.integration.test.ts \
  src/core/__tests__/cross-tenant-isolation.integration.test.ts
npx node-pg-migrate down 1 && npx node-pg-migrate up      # round trip, repro container
npx vitest run src/repos/__tests__/conversations.test.ts
npx tsc --noEmit --incremental false
npx eslint <changed source, tests, migration>
```

## Results

- **Fresh install**: 18/18 migrations applied and recorded; `ci-db-check` passed (app_user logs in, no
  BYPASSRLS). `ai-config` **12/12**, `global-persistence` **3/3**, `cross-tenant-isolation` **1/1**:
  16/16, 0 skipped.
- **Upgrade**: the 17 `origin/developer` migrations applied and recorded first; the second `up` applied only
  `1792640000000` (18 recorded, 18 distinct). `ci-db-check` passed; same suites **16/16**, 0 skipped.
- Fixture cleanup after every run: zero `kan70-integration-%` tenants, shared releases, module versions,
  defaults, or assignments.
- Down/up round trip: `down` dropped the three functions and restored the `1792378760000` pin trigger;
  `up` recreated them. Catalog: `lock_effective_platform_ai_release` and `materialize_platform_ai_release`
  are SECURITY DEFINER with `search_path=pg_catalog, public, app, pg_temp`, `row_security=off`, ACL
  `{postgres=X/postgres,app_user=X/postgres}`; `effective_platform_ai_shared_release` is not SECURITY
  DEFINER and has ACL `{postgres=X/postgres}` only.
- Unit `conversations.test.ts` 3/3 (new case: the repo materializes only through the helper and never
  reads `ai_shared_releases` or inserts into `ai_releases`). `tsc` and focused ESLint clean.
  `vitest related` on `conversations.ts`: 63 passed; the KAN-17 isolation file fails by design without DB URLs.

## Assertions covered by the new integration case (all through app_user)

- Global default, ordinary member, no activation: conversation is pinned to a frozen tenant-local platform
  materialization of the default shared release (same content hash, `created_by` = member). The admin's
  next conversation and two concurrent first conversations reuse it (exactly one tenant release).
- A local activation outranks the default; a module assignment outranks the activation; existing pins and
  the activation never move. A direct pin to the no-longer-effective default copy is rejected by the trigger.
- Retiring the effective shared release makes new conversations fail with the Spanish error, and a direct
  pin to its copy is rejected.
- Members still cannot insert `ai_releases` (RLS error), insert or update `ai_release_activations`, or
  activate through the repository, and cannot read unrelated shared releases.
- Helpers return null/false for a non-effective shared release, for a forged cross-tenant member context,
  and for a tenant with a local activation (no copy is created there). A foreign tenant member cannot read
  tenant C's release or conversation, nor pin a conversation to tenant C's release.
- PUBLIC lacks EXECUTE on all three functions; app_user cannot execute the internal resolver.

## Notes

- Precedence (assignment > active local release > global default) is unchanged; it was already defined by
  KAN-71 in `resolveNewConversationRelease` and `platform-config.getEffectiveVersion`. The SQL resolver
  mirrors it.
- Not changed: an assignment whose module version has no `shared_release_id` still yields "no active
  configuration" (as before). If a tenant admin retires a platform materialization, the unique clone index
  prevents a fresh copy, so that tenant cannot use that shared release again until a new shared release
  is published. This behavior is unchanged and was not in scope.
- `orchestrator-postgres.integration.test.ts` was not run (known pre-existing `announce_completion` failure).
