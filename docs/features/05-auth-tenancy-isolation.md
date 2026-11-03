[← Features](README.md)

# Auth, tenancy and data isolation

## What it does

Users sign in with WorkOS through their organization. Each organization is a tenant; a user sees
only their own conversations, messages and logos, and nobody can read another tenant's data,
even with a forged id. Platform operators sign in separately and must pass a TOTP step-up.

## How it works

1. **Gate every route.** `proxy.ts` (WorkOS AuthKit middleware, Next 16 "proxy") protects every
   route except `/login`, `/callback` and the two exact health paths `/api/health` and
   `/api/health/ready`. Login lives in `app/login/page.tsx` and `app/callback/route.ts`.
2. **Session → (tenant, user).** `src/auth/resolve-identity.ts:resolveIdentity` takes the
   organization id from the signed WorkOS session, looks up the registered organization and its
   status (`src/repos/global-organizations.ts:globalOrganizationsRepo`), checks a fresh active
   WorkOS membership and an existing active local user (`src/repos/identity.ts`). It returns a
   `ResolvedIdentity` with the tenant, the user, the tenant role from the database and, separately,
   the persisted platform role. It never creates tenants or users; any miss fails closed.
3. **Scoped repositories.** All tenant data goes through `src/repos/index.ts:repos(tenant, user)`
   (or `systemRepos(tenant)` for workers without a user). Each repository closes over the tenant
   and user, so no method can skip them.
4. **Transaction-local identity.** Each repository call runs inside
   `src/db/with-transaction.ts:withTenantTransaction`, which sets `app.tenant_id` and
   `app.user_id` with `set_config(…, true)` (transaction-local, safe behind PgBouncer).
   `withTenantAdminTransaction` is the tenant-wide variant; platform metadata uses
   `src/db/global-transaction.ts:withGlobalTransaction`.
5. **Row-Level Security.** Migrations enable and force RLS on every tenant table
   (`migrations/1777048001111_rls-policies.js`). Policies read the helpers created in
   `migrations/1777047967923_app-schema-and-helpers.js`: tenant-only tables match
   `tenant_id`; owner tables (conversations, messages, deliverables, approvals, terms) also
   require `user_id = current user` or a tenant admin for reads. Every foreign key is composite
   `(tenant_id, x_id)`, so a row cannot point into another tenant. Ids inside JSONB payloads are
   checked too (`assertJsonbTenantSafe` in `src/repos/agent-tasks.ts`).
6. **Runtime role.** The app connects as `app_user` (`APP_DATABASE_URL`), created without
   `BYPASSRLS` by `migrations/1777048068790_app-role-and-grants.js`. Migrations use a separate
   owner connection. Only `src/db/` and `src/repos/` touch the pool (`src/db/pool.ts`).
7. **Platform operators.** `requireGlobalAdmin` / `requireGlobalMfa` in
   `src/auth/resolve-identity.ts` check the persisted superadmin role
   (`src/repos/global-identity.ts`) plus a recent server-signed TOTP proof bound to the WorkOS user
   and session (`src/auth/platform-mfa.ts`, page `app/platform/mfa/page.tsx`). Tenant admins never
   get platform access. `src/auth/safe-next-path.ts:safeNextPath` validates post-MFA redirects.
8. **Developer role switcher (`DEVELOPMENT=TRUE` only).** `src/auth/role-override.ts` lets a
   developer act with *fewer* privileges through a cookie bound to their WorkOS user; `resolveIdentity`
   returns the reduced roles. UI: `components/DevRoleSwitcher.tsx`; actions:
   `app/actions/dev-roles.ts`. It never switches user or tenant.

## Key rules / invariants

- **Identity comes only from the signed session, never from the request.** Forged organization
  or tenant values are ignored. Enforced by `src/auth/__tests__/resolve-identity.test.ts`
  ("ignores forged caller-supplied organization and tenant values", "requires an active WorkOS
  membership and fails closed…").
- **No cross-tenant or cross-member reads or writes.** Enforced by the two-tenant PostgreSQL
  suite `src/core/__tests__/cross-tenant-isolation.integration.test.ts` (tenant rows, KAN-52
  asset keys, KAN-25 conversation list and opens, KAN-27 terms), run by CI's database job.
  Add a case for every new endpoint or table.
- **The runtime role cannot bypass RLS.** Enforced in CI by `scripts/ci-db-check.mjs` (fails if
  `app_user` has `BYPASSRLS` or cannot log in).
- **App code never imports the pool.** All access goes through `repos(...)` inside
  `withTenantTransaction`. Enforced by review only: there is no lint rule.
- **Tenant admin ≠ platform admin; reductions only remove access.** Enforced by
  `resolve-identity.test.ts` ("does not treat tenant admin status as platform authority") and
  `src/auth/__tests__/role-override.test.ts`.
- **Platform actions need a fresh MFA proof bound to the session.** Enforced by
  `src/auth/__tests__/platform-mfa.test.ts` and `app/platform/mfa/__tests__/page.test.tsx`.

## Decisions

- KAN-17 — two-tenant isolation suite added to CI
  ([`pipeline/kan-61-ci-policy.md`](../../pipeline/kan-61-ci-policy.md)).
- 2026-10-25 — KAN-79: developer role switcher is downgrade-only and exists only with
  `DEVELOPMENT=TRUE`.
- 2026-10-25 — KAN-80: the platform MFA proof cookie is scoped to `/` so it reaches `/admin/ai`.
- Account operations and member roles: KAN-66 is **proposed, awaiting owner approval**
  ([`pipeline/decisions/KAN-66-account-operations-roles.md`](../../pipeline/decisions/KAN-66-account-operations-roles.md)).

## Limits & known gaps

- Pilot scope: one institutional tenant. Personal-tenant provisioning is an open decision.
- Membership is checked live with WorkOS on each request, so a WorkOS outage blocks tenant
  access.
- There is no tenant-admin member management UI yet (KAN-66 pending).
- `agent_tasks` has no user axis in RLS; ownership is checked through the conversation in the
  app layer.
- The SQL helper `app.has_tenant_admin()` reads the persisted role, so RLS still sees a
  developer-reduced tenant admin as admin; app-level guards refuse first.

## See also

- [06-assets-storage.md](06-assets-storage.md) — owner-only asset access
- [10-admin-platform.md](10-admin-platform.md) — what platform operators can do
- [`docs/personal-data.md`](../personal-data.md) — which personal data is stored
