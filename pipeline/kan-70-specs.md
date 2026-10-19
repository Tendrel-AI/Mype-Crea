# KAN-70 supervision and delivery specification

Primary Codex supervises and reviews; all application code changes belong to smaller-model
coding subagents. Existing KAN-69 `pipeline/specs.md` remains separate. Preserve the dirty
workspace, including all staged, unstaged, and untracked prior work. No staging, commits,
pushes, deployment, paid calls/evals, production tracing uploads, or Jira comments/transitions
are authorized by this implementation plan.

Issue: https://matyaslopz.atlassian.net/browse/KAN-70 (read through Jira MCP).

## Settled decisions

- Active authenticated WorkOS organization maps to a registered tenant. Require fresh active
  WorkOS membership AND an existing active local membership; unknown orgs/users fail closed.
  No automatic tenant/user provisioning. Platform admins come from a server-configured
  WorkOS-user-ID allowlist, separately from local tenant-admin roles.
- Implementation routing: server-only `WORKOS_ORGANIZATION_TENANTS` map selects a candidate
  tenant; scoped identity repository checks its persisted organization mapping. Configuration
  alone never grants membership. This preserves scoped repositories and FORCE RLS without
  an unrestricted pre-tenant query or privileged database role.
- Tenant admins may read full conversation/trace content inside their own tenant. Members
  retain ownership restrictions. Every server read/write/export requires authorization.
- Historical conversations are disposable test data. Do not reconstruct historical releases
  or build a legacy migration flow. Classify unversioned conversations explicitly and direct
  users to a new conversation; no silent retrospective pinning.
- At most two attempts per operation: original plus one approved alternative. No automatic
  repetition after ambiguous timeouts/acceptance. Monetary budgets remain KAN-43; report
  unconfigured/unknown budget and cost honestly, never fabricate a monetary cap or zero cost.
- Retain local traces until explicit deletion. Owner and own-tenant administrator may
  explicitly export content. Production conversation uploads to LangSmith remain blocked.
- Existing Jira product decisions continue: platform-owned credentials/shared releases,
  tenant-permitted overrides, immutable conversation pins, automatic compatible fallback
  with durable notice, no evaluation runs or quality rubric in this delivery.

## Integrated outcome required

An authorized admin can edit/import, validate/diff, freeze and activate a locally stored
release. New conversations pin an immutable release. Changing the tenant default affects
new conversations only. Original profiles remain usable while authorized; provider
unavailability can select one compatible approved alternative with durable typed feedback.
Frozen prompt/schema/settings and behavior identities must be used in actual requests.

Durable turn IDs, reserved execution plans and checkpoints must prevent retrying committed
extraction/state changes/image dispatch after only the response failed. Ambiguous external
execution must be recorded and fail recoverably rather than pretending exactly-once calls.
Restart/concurrency require durable ownership, effect identity and state; an in-memory lock
alone is insufficient. Planner/merge remain pure and agents use IAgentTransport exclusively.

Shared catalog access must use explicit separate platform scope, never a magic tenant or
tenant-admin elevation. New tenant persistence requires composite tenant FKs/indexes,
ENABLE/FORCE RLS, app_user without BYPASSRLS, scoped repositories/transactions and reversible
migrations. Release immutability needs database enforcement as well as service checks.

## Delegation slices

1. Identity/authorization and focused fake-WorkOS tests (`identity_design`).
2. Executable frozen adapter behavior and optional explicit model injection
   (`execution_design`). Preserve baseline behavior except required prompt-language fixes.
3. Strict inert manifest validation, canonical hashing and diffs (`manifest`).
4. Tenant/platform-scoped release, activation, audit, conversation-pin, turn/attempt/trace
   persistence with database constraints and focused verification.
5. Runtime provider registry, supported-runtime checks, release resolution and bounded
   fallback; controller checkpoints and durable effects; typed public results and reload.
6. Authorized administration UI, local JSON/Git-compatible import/export and pinned
   LangSmith synchronization with durable visible status/retry. No hidden network probes.
7. Integrated review, targeted tests/lint/typecheck, security/recovery verification and docs.

Actual interface details live in `pipeline/kan-70-manifest-contract.md` and
`pipeline/kan-70-adapter-contract.md`. Coordinate changes between their owners.

## Verification and remaining approvals

Read `docs/agents/testing.md` before tests; run affected test files using fakes. Typecheck
with incremental disabled. Real DB migrations/integration tests require user agreement after
the migration and checks are concrete and reviewable. No paid model/image/eval calls.
Update affected local-only docs/rules without force-adding them. Do not claim KAN-70 complete
after foundation modules alone; report remaining acceptance gaps honestly.

## Offline implementation status (2026-10-18)

Implemented in source and covered by focused fake/pure tests: owner-authorized conversation trace
export (messages, turns, attempts, notices, deliverables, and pinned release identity), explicit
usage accounting status (`complete`/`partial`/`unknown`/`no_attempts`), and an explicit
`unconfigured` budget status. These fields do not set or enforce a monetary budget; that policy
remains deferred to KAN-43. The migration and repository SQL/RLS still need the dedicated
PostgreSQL integration validation before database acceptance can be claimed. See
`docs/agents/testing.md` for the exact test and approval boundary.
