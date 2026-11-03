[← Features](README.md)

# Admin and platform operator

## What it does

Platform operators (superadmins) get a separate console, «Panel de plataforma», at `/platform`:
create, rename and deactivate organizations (each linked to a WorkOS organization), grant or
revoke other operators, publish and roll out module versions (today the AI module) to
organizations, see monthly metrics per organization, and read an append-only audit trail.
Tenant admins do not see this console; they get `/admin/ai` and read access to their members'
data within the tenant.

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
   calls and tokens, estimated cost, and active module versions.
6. **Audit trail.** `app/platform/audit/page.tsx` reads `platform_audit_events` through
   `getPlatformAuditTrail`; writes go through `src/repos/global-audit.ts:insertGlobalAuditEvent`.
   Tenant-level AI configuration changes are audited separately in `ai_config_audit_events`.
7. **Tenant admin.** A tenant admin uses `/admin/ai` for the tenant's AI releases, provider
   availability, usage summary and turn traces ([09-ai-configuration.md](09-ai-configuration.md)),
   and RLS lets them read (not write) their members' conversations and approvals.

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
- **Metrics are aggregates only: no user or content columns.** Enforced by the shape of
  `app.platform_monthly_metrics` and `src/repos/__tests__/platform-metrics.test.ts`.

## Decisions

- 2026-10-19 — KAN-71 platform administration merged. Spec:
  [`pipeline/kan-71-specs.md`](../../pipeline/kan-71-specs.md).
- 2026-10-21 — KAN-77: new conversations on the platform path materialize the effective platform
  release into the tenant. Validation:
  [`pipeline/kan-77-db-validation-2026-10-21.md`](../../pipeline/kan-77-db-validation-2026-10-21.md).
- Tenant-admin member management (provision, deactivate, reactivate members) is KAN-66,
  **proposed, awaiting owner approval**
  ([`pipeline/decisions/KAN-66-account-operations-roles.md`](../../pipeline/decisions/KAN-66-account-operations-roles.md)).

## Limits & known gaps

- No member management for tenant admins yet (KAN-66); members are provisioned outside the app.
- The AI module is the only platform module.
- Cost figures are estimates; unknown cost stays unknown.
- ⚠️ Unverified: whether the platform console flows (organization create, rollout) were exercised
  against a deployed environment.

## See also

- [05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md) — identity and MFA
- [09-ai-configuration.md](09-ai-configuration.md) — the releases being rolled out
- [11-operations.md](11-operations.md) — deployment and recovery
