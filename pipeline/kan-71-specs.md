# KAN-71 implementation specification

Issue: https://matyaslopz.atlassian.net/browse/KAN-71
Target: `developer`; isolated worktree: `/private/tmp/mype-crea-kan-71` on `codex/kan-71`.
Planner: primary Codex agent. Implementation: parallel `coder` subagents only. The primary agent does not edit application code.

## Agreed product behavior

- A WorkOS-authenticated superadmin is a global identity with no required organization membership or active organization. The role is persisted independently of tenant membership and checked on every server operation. Tenant admins and users have no global access.
- Bootstrap the first superadmin from one configured WorkOS user ID environment variable, only when no persisted superadmin has ever been granted. Persist the grant and audit it. Removing/revoking the persisted role must not silently regrant it on a later request or restart. Subsequent grants and revocations require an authorized global actor and are audited. Do not expose a public bootstrap route.
- Console-specific TOTP step-up uses the WorkOS MFA API after primary WorkOS sign-in. Require recent verified proof bound to the current WorkOS session on every console action and page. Enrollment, challenge and verification remain server-side. Never trust client-provided MFA state. Fail closed if WorkOS verification is unavailable.
- A new narrowly scoped global repository/transaction layer is approved for global identity, organization metadata, module configuration, audit and aggregate metrics. It must not expose tenant content. The existing tenant repos remain tenant-scoped; only the repository layer touches the DB pool. Runtime remains `app_user` without `BYPASSRLS`, and global tables/functions have explicit RLS/least-privilege rules.
- Organizations can be created, listed, edited, deactivated and reactivated; never physically deleted. Creation must be idempotent across WorkOS and local DB, with a durable operation key and reconciliation after partial failure. Use WorkOS organization external ID if appropriate. Invite delivery is out of scope. Deactivation blocks tenant access, new conversations and streams in the app, while preserving WorkOS memberships and all data/configuration for reactivation.
- A module contract declares global settings, tenant settings, permissions, aggregate metrics and activation actions. The console discovers registered modules without editing its central layout. Integrate the current AI module using that contract.
- Global config versions support one, selected, or all organizations, preview, per-organization results, idempotent retry, global default for future organizations, explicit tenant exception, audit and rollback to a previous version. Existing immutable AI shared releases and tenant-local pins should be reused or bridged rather than weakened. A conversation remains pinned to its selected immutable release.
- Monthly metrics show active users, new conversations, provider/model usage, estimated cost, errors and active versions by organization and platform. The user explicitly changed the ticket's small-cohort suppression requirement: **show cells even when only one user is active**. There is no user dimension, drill-down, arbitrary time-range filter or private content; fixed calendar months only. Do not expose member personal data.
- All global mutations audit actor, time, scope, prior/new version, outcome and reason where applicable, with no private tenant content. User-facing text uses neutral Latin-American Spanish with tuteo.

## Integration boundaries

1. Global persistence and organization lifecycle: new migration(s), RLS/policies/functions/grants, global repository and transaction helpers, WorkOS create/update reconciliation, metadata/status gates, audit. Coordinate stable interfaces with other coders; own migration files exclusively.
2. Global auth and MFA: WorkOS session identity, persisted-role authorization, one-time bootstrap, TOTP step-up, login/navigation and tenant-access gates. Do not use tenant membership as global authorization. Coordinate repository interface with workstream 1. Own `src/auth/**`, relevant auth routes/actions, and access gates in `app/actions/chat.ts`, conversation actions, SSE route, workers as needed.
3. Modules/configuration rollout: registry/contract and AI module, version/default/override/preview/apply/retry/rollback service and repository methods, runtime selection for new conversations, audit. Coordinate schema with workstream 1; do not edit its migration files. Do not modify pure planner/merge or agent transport semantics.
4. Metrics and console UI: aggregate-only repository queries and monthly service, console pages/actions/components, organization/version/rollout/metrics views; no links or endpoints to tenant content. This can start once backend contracts are available. Use server authorization for every action, never only client hiding.

## Required verification

- Read `docs/agents/testing.md` and matching `.claude/rules/` before testing. Run focused unit files with fakes; typecheck and lint changed files. Do not run real DB integration tests, migrations, evals, paid APIs or live WorkOS calls without explicit user approval. WorkOS requests in tests are mocked.
- Cover no-org global login, non-superadmin denial, MFA denial/expiry/session binding, one-time bootstrap and revocation, org deactivation gates, idempotent partial-failure recovery, rollout scopes/default/exception/rollback, metrics query shape and no private fields, module auto-discovery.
- Document schema and new auth/repository exception in ignored local `docs/agents/` and `.claude/rules/`, and new env vars in `.env.example`/stack docs. Do not resolve unrelated `TBD with user` items. Never stage or commit on behalf of the primary agent.
- Preserve all existing workspace changes. The `developer` worktree contains an unrelated untracked migration. Do not edit, move or delete it. Work only in `/private/tmp/mype-crea-kan-71`; do not revert another coder's edits.

## Integration review gates

- The primary agent reviews each workstream against the ticket and this spec, verifies focused checks, obtains approval for real DB integration tests if needed, then commits and merges `codex/kan-71` into `developer`.
- Any merge conflict goes back to coder subagents for resolution, followed by review and focused verification. Do not deploy or mutate Jira.
