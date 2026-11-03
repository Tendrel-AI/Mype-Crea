# KAN-17: cross-tenant isolation evidence (controlled leak)

Date: 2026-11-03. Branch `feat/kan-17-evidence`. Everything below ran against a **throwaway**
PostgreSQL 18.4 cluster (`initdb` in a scratch directory, port 55481, database `mype_ci`), never
against `.env.local`, a shared database or production. The leaks were applied only in that database
with `psql` and were never committed to code or migrations. The cluster was stopped and deleted
afterwards.

Suite: `src/core/__tests__/cross-tenant-isolation.integration.test.ts` (5 tests). This change adds
cross-tenant DELETE assertions: tenant B deletes tenant A's `deliverables`, `messages`,
`agent_tasks` and `conversations` rows by known id, and each DELETE must affect 0 rows while the
row still exists for the owner connection.

## Setup

```sh
S=<scratch>/pg17; initdb -D $S -U postgres --auth=trust
pg_ctl -D $S -l $S.log -o "-p 55481 -c unix_socket_directories='' -c listen_addresses=localhost" start
createdb -h localhost -p 55481 -U postgres mype_ci
env -u APP_DATABASE_URL -u MIGRATION_DATABASE_URL DATABASE_URL=postgres://postgres@localhost:55481/mype_ci npx node-pg-migrate up
# run.sh:
env -u MIGRATION_DATABASE_URL DATABASE_URL=postgres://postgres@localhost:55481/mype_ci \
  APP_DATABASE_URL=postgres://app_user:change_me_immediately@localhost:55481/mype_ci \
  npx vitest run src/core/__tests__/cross-tenant-isolation.integration.test.ts \
  --reporter=default --reporter=junit --outputFile.junit=<scratch>/junit/<name>.xml
```

## 1. Baseline: green

```
 ✓ src/core/__tests__/cross-tenant-isolation.integration.test.ts (5 tests) 56ms
 Tests  5 passed (5)
JUNIT: <testsuites name="vitest tests" tests="5" failures="0" errors="0" ...>
```

## 2. Leak attempt that is not a leak: DELETE-only permissive policy

```sql
CREATE POLICY kan17_leak_delete ON deliverables FOR DELETE TO app_user USING (true);
```

```
 Tests  5 passed (5)
```

Expected and recorded on purpose: PostgreSQL also applies the table's SELECT policies to a DELETE
whose `WHERE` reads the row, so tenant B still cannot see, and therefore cannot delete, tenant A's
row. A DELETE-only policy does not open a hole. Reverted with
`DROP POLICY kan17_leak_delete ON deliverables;`.

## 3. Controlled leak: RLS disabled on `deliverables` → suite FAILS

```sql
ALTER TABLE deliverables DISABLE ROW LEVEL SECURITY;
```

```
- Expected
+ Received
- Array []
+ Array [
+   Object {
+     "contentInline": Object { "label": "synthetic A" },
+     "conversationId": "be52297e-0f38-491b-9ebd-60e979faa726",
+     "id": "cca70ab1-a5d5-462b-be05-6ba2b0cf04d3",
+     "kind": "logo", ...
+   },
+ ]
 ❯ src/core/__tests__/cross-tenant-isolation.integration.test.ts:239:80
    239|     expect(await ownB.deliverables.listByConversation(tenantA.conversa…

 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
JUNIT: <testsuites name="vitest tests" tests="5" failures="1" ...>
```

Tenant B read tenant A's deliverable, so the read assertion failed before reaching the DELETE
checks. To show the new DELETE assertion targets a real effect, the same leak was checked directly
as `app_user` with tenant B's GUCs, inside a transaction that was rolled back:

```
BEGIN;
SELECT set_config('app.tenant_id', '<tenant B>', true), set_config('app.user_id', '<user B>', true);
DELETE FROM deliverables WHERE id = 'cca70ab1-a5d5-462b-be05-6ba2b0cf04d3';
DELETE 1
ROLLBACK;
```

## 4. Reverted → suite green again

```sql
ALTER TABLE deliverables ENABLE ROW LEVEL SECURITY;
-- posture check: agent_tasks, conversations, deliverables, messages all relrowsecurity = t,
-- relforcerowsecurity = t; 0 policies named kan17%
```

```
 ✓ src/core/__tests__/cross-tenant-isolation.integration.test.ts (5 tests) 53ms
 Tests  5 passed (5)
```

The same direct DELETE as tenant B now returns `(0 rows)`.

Full integration set on the same throwaway database after the revert: 14 files, 86 tests passed.

## CI report

The `Database migrations` job in `.github/workflows/ci.yml` now runs the suite with the JUnit
reporter (`test-results/cross-tenant-isolation.junit.xml`) and uploads it as the
`cross-tenant-isolation-report` artifact with `if: always()`, so the report exists on red runs too.
The job stays report-only (KAN-61).
