[← Features](README.md)

# Admin and platform operator

## What it does

Platform operators (superadmins) get a separate console, «Panel de plataforma», at `/platform`:
create, rename and deactivate organizations (each linked to a WorkOS organization), grant or
revoke other operators, publish and roll out module versions (today the AI module) to
organizations, see monthly metrics per organization, and read an append-only audit trail.
Tenant admins do not see this console; they get `/admin/ai`, read access to their members'
data within the tenant, and `/admin/accounts` to create, deactivate and reactivate the
accounts of their own tenant (KAN-41).

## How it works

1. **Entry.** `app/page.tsx` sends a signed-in platform admin to `/platform` (or `/platform/mfa`
   first when there is no recent proof). Every platform page and action calls
   `requireGlobalMfa` (`src/auth/resolve-identity.ts`): persisted superadmin role plus a recent
   TOTP proof ([05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md)). Platform metadata is
   accessed through `src/repos/global.ts:globalRepos` inside
   `src/db/global-transaction.ts:withGlobalTransaction`. Shared Spanish labels live in
   `app/platform/labels.ts`.
2. **Organizations.** `app/platform/organizations/page.tsx` and
   `app/platform/organizations/[tenantId]/page.tsx`; actions `createPlatformOrganization`,
   `renamePlatformOrganization`, `setPlatformOrganizationActive` in
   `app/actions/platform-admin.ts`. `src/services/platform/organizations.ts:PlatformOrganizationService`
   creates the WorkOS organization idempotently (by an operation key used as WorkOS
   `externalId`), attaches it to a local tenant (`src/repos/global-organizations.ts`), records
   reconciliation when one side fails, and compensates a WorkOS rename if the local one fails.
   A deactivated organization blocks sign-in and open streams for its members.
3. **Operators.** `app/platform/operators/page.tsx`; `grantPlatformOperator` /
   `revokePlatformOperator` over `src/repos/global-identity.ts:globalIdentityRepo`. The first
   superadmin is bootstrapped once from `PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID`; later
   grants and revocations are audited.
4. **Modules and rollouts.** `app/platform/modules/page.tsx` and
   `app/platform/modules/[moduleId]/page.tsx`; actions in `app/actions/platform-modules.ts`. The
   module catalog is `src/services/platform/modules/registry.ts` (contract in
   `src/services/platform/modules/contract.ts`; the AI module is
   `src/services/platform/modules/ai.ts:aiPlatformModule`).
   `src/services/platform/rollout/service.ts:ModuleRolloutService` publishes immutable
   versions, previews target organizations, applies a rollout (scopes: global default for future
   organizations, one, selected or all organizations) with a per-organization outcome, retries, and rolls back by re-applying an older
   version. An organization's effective version comes from an organization assignment, a tenant
   activation or the global default.
5. **Metrics.** `app/platform/metrics/page.tsx` and the organization page call
   `src/services/platform/metrics/monthly.ts:getPlatformMonthlyMetrics` →
   `src/repos/platform-metrics.ts:platformMetricsRepo`, which reads the SQL function
   `app.platform_monthly_metrics` (migration `migrations/1777500000000_platform_global_access.js`):
   per calendar month and organization, active users, new conversations, errors, provider/model
   calls and tokens, estimated cost, and active module versions. `getPlatformMonthlyMetrics`
   then suppresses small cohorts (KAN-71): a row with fewer than 5 active users in the month
   (an organization, or the platform total) returns `suppressed: true` and `null` counts and
   costs, and the pages show «Datos insuficientes para mostrar».
   Per-conversation metadata, the monthly random sample and the pilot metrics report (KAN-42) are
   operator scripts over `globalRepos().trace`, never content: [15-trace-and-metrics.md](15-trace-and-metrics.md).
6. **Audit trail.** `app/platform/audit/page.tsx` reads `platform_audit_events` through
   `getPlatformAuditTrail`; writes go through `src/repos/global-audit.ts:insertGlobalAuditEvent`.
   Tenant-level AI configuration changes are audited separately in `ai_config_audit_events`.
7. **Tenant admin.** A tenant admin uses `/admin/ai` for the tenant's AI releases, provider
   availability, usage summary, turn traces and the full trace of a member's conversation
   (KAN-42) ([09-ai-configuration.md](09-ai-configuration.md)),
   and RLS lets them read (not write) their members' conversations and approvals.
8. **Tenant accounts (KAN-41).** `app/admin/accounts/page.tsx` + `components/TenantAccountsAdmin.tsx`;
   actions `getTenantAccounts`, `provisionTenantMember`, `deactivateTenantMember`,
   `reactivateTenantMember` in `app/actions/tenant-accounts.ts`. Each re-resolves the session
   with `requireTenantAdmin` (`src/auth/resolve-identity.ts`, the reusable guard; it throws
   `TenantAdminRequiredError` carrying the identity, so callers log refusals). A refused member
   is logged (`tenant_accounts.refused_not_admin`) and nothing is touched.
   `src/services/tenant-accounts.ts:TenantAccountService` holds the rules and talks to WorkOS
   only through `WorkosAccountsClient` (`createWorkosAccountsClient`; tests inject a fake):
   - **Provision** (email → WorkOS user + organization membership, then a local `member` row):
     WorkOS first, then the DB. Idempotent by email. If the DB fails after WorkOS, the
     membership grants nothing (sign-in also needs the local active row) and a retry reuses it.
     No invitation email is sent; the admin shares the login link.
   - **Deactivate**: local `status = 'inactive'` first (access ends on the next request or
     stream recheck), then the WorkOS membership. A WorkOS failure is audited
     (`workos_sync_failed`). Data is kept.
   - **Reactivate**: WorkOS first, then the DB, for the same reason as provision.
   - Guards: no self-deactivation, never the last active admin, forged or other-tenant ids
     answer «No encontramos esa cuenta en tu organización.» and never reach WorkOS.
   `src/repos/tenant-accounts.ts:tenantAccountsRepo` (via `repos(t,u).tenantAccounts`) checks
   `app.has_tenant_admin()` in every transaction, locks the tenant's active admins before a
   status change (two admins removing each other leave one), and writes the
   `tenant_account_audit_events` row in the same transaction as the change.

## Key rules / invariants

- **Platform authority is separate from tenant membership and needs fresh MFA.** Environment
  allowlists never grant access. Enforced by `src/auth/__tests__/resolve-identity.test.ts` and
  `src/auth/__tests__/platform-mfa.test.ts`.
- **Organization operations are retry-safe and never half-done silently.** Enforced by
  `src/services/platform/__tests__/organizations.test.ts` (externalId reconciliation, rename
  compensation, audited partial failures).
- **Rollouts are previewed, per-organization, and reversible; versions are immutable.** Enforced
  by `src/services/platform/rollout/__tests__/service.test.ts` and the database triggers
  `platform_module_versions_immutable` / `platform_audit_append_only`.
- **A tenant admin manages only their own tenant's accounts, and every step is audited.** Only an
  active tenant admin can write `users` (RLS + column grants: insert a new active `member`,
  update `status`; no role change, no delete) or read and append `tenant_account_audit_events`.
  Enforced by `src/repos/__tests__/tenant-accounts.integration.test.ts` (goal flow, refusals,
  concurrent last-admin race, grants/RLS), the KAN-41 case in the CI suite
  `src/core/__tests__/cross-tenant-isolation.integration.test.ts`,
  `src/services/__tests__/tenant-accounts.test.ts` and `app/actions/__tests__/tenant-accounts.test.ts`.
- **Metrics are aggregates only: no user or content columns.** Enforced by the shape of
  `app.platform_monthly_metrics` and `src/repos/__tests__/platform-metrics.test.ts`.
- **Small cohorts expose no counts (k = 5).** Applied server-side, never only in the UI.
  Enforced by `src/services/platform/metrics/__tests__/monthly.test.ts` and
  `app/platform/metrics/__tests__/page.test.tsx`.

## Decisions

- 2026-10-19 — KAN-71 platform administration merged. Spec:
  [`pipeline/kan-71-specs.md`](../../pipeline/kan-71-specs.md).
- 2026-11-03 — KAN-71 small-cohort suppression approved (k = 5), superseding the spec's
  "show cells even for one user"
  ([`pipeline/decisions/KAN-71-small-cohort-suppression.md`](../../pipeline/decisions/KAN-71-small-cohort-suppression.md)).
- 2026-10-21 — KAN-77: new conversations on the platform path materialize the effective platform
  release into the tenant. Validation:
  [`pipeline/kan-77-db-validation-2026-10-21.md`](../../pipeline/kan-77-db-validation-2026-10-21.md).
- 2026-11-02 — KAN-66 approved (Option B): tenant admins provision, list, deactivate and
  reactivate members; no in-tenant role changes, no deletion, no invitation emails; first admin
  and admin changes stay with platform operators
  ([`pipeline/decisions/KAN-66-account-operations-roles.md`](../../pipeline/decisions/KAN-66-account-operations-roles.md)).
  Implemented by KAN-41 (migration `1792800012000_tenant-account-admin`).

## Limits & known gaps

- The first tenant admin and any admin grant or revocation have no console flow yet: a platform
  operator does them in WorkOS plus SQL as the migration owner, outside `platform_audit_events`
  ([`docs/operations.md`](../operations.md) section 11).
- No account deletion/anonymization, role changes, invitations or bulk import (KAN-66 Option C).
- ⚠️ Unverified: the account flows against real WorkOS and in a browser.
- The AI module is the only platform module.
- Cost figures are estimates; unknown cost stays unknown.
- ⚠️ Unverified: whether the platform console flows (organization create, rollout) were exercised
  against a deployed environment.

## See also

- [05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md) — identity and MFA
- [09-ai-configuration.md](09-ai-configuration.md) — the releases being rolled out
- [11-operations.md](11-operations.md) — deployment and recovery
