# Enable tenant-safe AI administration with frozen releases and resilient conversations

Target project: KAN (verified in Jira).
Issue type: Story under KAN-22, the existing administration/tracing/usage Epic.
Publication status: created and read back as [KAN-70](https://matyaslopz.atlassian.net/browse/KAN-70)
on 2026-10-18.
GitHub visibility: [Tendrel-AI/Mype-Crea#1](https://github.com/Tendrel-AI/Mype-Crea/issues/1),
with the full handoff and a link back to Jira. Jira has a native web link to the GitHub issue.
Jira remains the primary planning record; this is not automatic bidirectional synchronization.
Scope: one objective-oriented issue with ordered work packages; no child tickets created.

## Objective

Enable authorized administrators to manage CreaMype's prompts, models and fallback profiles
through the application, publish immutable behavior releases, and continue existing
conversations safely when provider availability changes. Preserve tenant isolation and
complete execution evidence so future evaluations can compare quality per dollar using
replaceable scoring criteria.

The first delivery succeeds when an admin can freeze and activate a release for their
permitted scope, a conversation pins it, and that conversation either continues on its
original profile or uses a compatible approved fallback with a visible notice and audit trail.
Evaluation runs are explicitly deferred until product functionality works.

## Product decisions (settled; do not reopen without a concrete implementation conflict)

The user explicitly delegated the following policy choices to Codex:

1. **Admin UI is the main interaction point.** Use a hybrid with Git for reviewable portable
   configuration snapshots and LangSmith for pinned prompt references and later synthetic
   experiment comparisons.
2. **Platform admins own shared releases, allowed provider/model capabilities and platform
   credentials.** Tenant admins activate/configure only permitted overrides within their
   own tenant. Ordinary members cannot administer configuration. Platform administration is
   distinct from a tenant's admin role.
3. **Platform-managed credentials initially.** Attribute usage and budgets per tenant.
   Tenant-supplied credential onboarding is outside initial scope. Release manifests store
   opaque credential references, never secret values.
4. **Conversations retain their original immutable release.** Activating a tenant default
   changes new conversations only. A default switch does not itself disable an old provider.
5. **Automatic approved fallback in product conversations**, with a durable visible notice.
   Fallback must be tenant-authorized and compatible with the operation's tool/schema/settings
   requirements. No user confirmation is required for an eligible fallback.
6. **Future frozen benchmarks fail explicitly on unexpected provider substitution.** A
   resilience/fallback benchmark may opt in explicitly; never silently mix profiles.
7. **Quality per dollar is a future objective, not a defined metric today.** Keep generation
   evidence, metric plugins, judge profiles, scoring and aggregation independently versioned.
   Do not invent a quality rubric or run evaluations in this delivery.
8. **Keep existing production LangSmith upload restrictions.** Full local tracing does not
   authorize exporting tenant conversations to a cloud service.

## Current problem and verified starting point

- `src/auth/resolve-identity.ts` currently assigns every authenticated WorkOS user to
  `PILOT_TENANT_ID`. It does not resolve organization membership, read admin role/status, or
  implement platform-admin authorization. There is no admin UI today.
- `users.role` already supports admin/member, but a seeded admin is not an authorization gate.
- `src/db/with-transaction.ts::withTenantAdminTransaction` only establishes database context;
  it is not a permission check. Tenant-admin RLS bypasses the user axis, not tenant boundaries.
- `src/services/llm/index.ts` selects one deployment-wide cached provider. Adapters resolve
  models through that singleton rather than explicit tenant/conversation execution profiles.
- Prompt builders, manual version labels and generation settings live inside adapters.
  Agent Card hints affect rendered prompts too; freezing a template alone is insufficient.
- Successful product calls persist tokens/latency through `withLlmLogging`, but there is no
  complete frozen run identity, durable attempt/error/cost accounting or modular trace sink.
- Existing evals exercise Extractor and Responder separately. Their setup mocks product audit
  writes; product and future evaluation/judge costs must remain separate accounting streams.
- Task ownership/announcements remain partly process-local. Known recovery and duplicate-effect
  risks must be addressed in the continuation path rather than replaying entire user turns.
- LangSmith is present; LangGraph runtime is not. This objective does not require a migration.
- Existing Jira work includes KAN-41 (tenant account administration), KAN-42 (durable traces),
  KAN-43 (pre-invocation consumption limits), and KAN-60 (future reproducible baseline).
  Coordinate with these issues instead of building parallel authorization, trace or budget systems.
  Implement multi-tenant boundaries and synthetic isolation verification without provisioning
  additional production organizations or silently expanding the existing pilot deployment.

## Required capabilities

### Tenant-safe administration

- Resolve the active tenant from authenticated membership and reject unknown/revoked/disabled
  access. Do not accept an arbitrary browser-supplied tenant as authority.
- Authorize every administrative server read/write/export. UI route hiding alone is insufficient.
- Display the active tenant and permission scope clearly. Platform capabilities must not be
  inferred from a tenant admin flag or generic RLS context helper.
- Implement persistence through scoped repositories/transactions; preserve app_user without
  BYPASSRLS, FORCE RLS, tenant-leading indexes and composite tenant foreign keys.
- Design shared catalog access explicitly; do not create a magic tenant or unrestricted
  cross-tenant query helper. Authorization and tenant filtering apply to trace exports too.

### Release lifecycle and hybrid synchronization

- Support draft editing/import, validation, diff, immutable freeze, activation, retirement,
  and rollback for new conversations. Referenced releases cannot be edited/deleted in place.
- Frozen identity covers prompt content and renderer, Agent Cards/hints, tools/output schemas,
  parser/history policy, provider/model/revision where available, generation settings,
  planner/merge code and thresholds, compatibility range, and code/dependency snapshot.
- Persist validated frozen content locally. Remote `latest` tags must not determine execution.
- Database owns runtime releases, activations and audit history. Git is the review/export
  snapshot; imports produce drafts. LangSmith references are pinned commits. Neither remote
  editor silently overwrites a live release.
- Show synchronization status/errors and permit retry. Avoid hidden paid health calls on
  admin page loads. Separate config validity, connectivity and model quality statuses.
- Keep secrets outside configuration content, logs, browser responses, exports and LangSmith.

### Pinned execution and safe fallback

- Separate immutable behavior release, tenant default activation and mutable provider availability.
- Inject execution profiles at adapter/effect boundaries. Do not mutate process environment or
  swap a shared singleton per request to choose a tenant's provider. Tenant-aware cache keys
  must include the release/profile and credential identity.
- Resolve per purpose: the Extractor requires forced tool/schema compatibility; the Responder
  has different requirements. Reuse pinned prompts/settings when compatible. Necessary
  behavioral changes require an independently frozen compatible profile with explicit lineage.
- Permit only finite, ordered, configured fallback chains constrained by tenant availability,
  credentials, capability, context and attempt/cost policy. No cycles, cross-tenant keys,
  unrestricted deployment-default fallback or bypass of content/authorization refusals.
- Preserve pinned release and record effective per-purpose profiles, resolution-policy version,
  reason, attempts and outcomes for each turn. Fallback does not permanently repin a conversation.
- Use durable turn/dispatch/response identity and a reserved execution plan. Revalidate policy
  before calls, serialize/version concurrent writes, and recover after restart. Do not repeat
  committed extraction/state mutation/image dispatch when only response rendering failed.
- Record ambiguous provider acceptance/timeouts explicitly; do not claim exactly-once external
  execution or duplicate-charge prevention where the provider cannot guarantee it.
- Classify historical conversations without metadata as `legacy_unversioned`. Do not fabricate
  their original configuration from current environment values. Provide an explicit migration
  or recoverable continuation outcome.
- Validate executable release compatibility: freezing a label cannot preserve an unavailable
  parser/runtime forever. Reject unsupported releases clearly or require explicit migration.

### User feedback and trace foundation

- Return typed public notices/errors rather than matching raw provider exceptions in the browser.
- Render fallback notice outside LLM prose and restore it from durable turn data after reload.
- Example fallback notice: "El servicio original de esta conversación no está disponible.
  Continuamos con una alternativa autorizada y conservamos tu progreso."
- Example exhausted-fallback error: "No pudimos continuar esta conversación porque su servicio
  original no está disponible y no hay una alternativa autorizada. Tu historial se conserva.
  Intenta de nuevo más tarde o contacta al administrador."
- Promise saved progress only after persistence succeeds. Keep provider internals and secrets
  out of business-user errors. Admin diagnostics expose a correlation ID and safe failure category.
- Record parent/child execution identity; pinned/effective releases; request/schema/output;
  validation/planner outcomes; timing; attempts/errors; fallback and delivery events; reported
  token categories; cost source/currency/pricing version. Redact secrets before persistence.
- Unknown tokens/cost remain unknown, not zero. Distinguish actual charges from estimates,
  model-call from end-to-end latency, and product from future eval/judge expenditure.
- Scope content access, export, retention/deletion and audit. Full traces must not imply that
  every tenant admin can read every member's conversation; finalize that permission separately.
- Prepare interfaces for future independently versioned evaluators and rescoring saved outputs;
  do not implement a speculative scoring framework or enable evaluation execution now.

## Acceptance criteria

- [ ] Platform admins can publish shared releases/profiles; tenant admins can change only
  permitted own-tenant activations/overrides; members cannot change configuration. Forged tenant
  IDs, foreign release IDs, revoked membership and unauthorized read/write/export fail closed.
- [ ] All new tenant persistence obeys repository/transaction/RLS conventions. Two-tenant and
  same-tenant user/role isolation are verified, including shared-catalog and trace/export paths.
- [ ] Admin can edit/import a draft, validate it, inspect a diff, freeze and activate a release.
  Frozen content hashes are stable; changing content creates a new release. Sync failure is visible.
- [ ] A new conversation pins its release durably. Changing/rolling back the tenant default
  affects new conversations only; restarting the app preserves existing pins.
- [ ] A Gemini/OpenRouter conversation continues using its original profile after the default
  becomes direct Anthropic, if the old profile remains authorized and usable.
- [ ] If that original profile becomes unavailable, an eligible approved alternative runs
  automatically, a durable notice appears, and pinned/effective identities and attempt usage
  remain distinguishable. Incompatible models and unauthorized credentials are never used.
- [ ] No eligible fallback produces a typed recoverable error without changing the pin or
  losing committed history. Duplicate/retried requests and restart do not replay already
  committed extraction, state writes or logo dispatch; ambiguous external acceptance is recorded.
- [ ] Legacy unversioned and unsupported-runtime conversations have explicit visible outcomes;
  no retroactive frozen identity is invented.
- [ ] Successful, failed and fallback attempts have safe local trace evidence and usage/cost
  attribution. Missing cost is distinguishable from zero; secrets and cross-tenant data do not leak.
- [ ] Admin screens show active scope, release status, original/effective profiles, per-tenant
  usage/budget status, provider-reference status, synchronization and actor audit history.
- [ ] Pure deterministic planner/merge boundaries and IAgentTransport remain intact. No provider
  routing or tenant-specific conditionals are added to deterministic business policy.
- [ ] Future scorer/judge identities can be recorded without redefining raw execution evidence.
  No rubric, quality-per-dollar claim, paid eval, hidden paid connectivity probe or production
  LangSmith content upload is introduced by this issue.
- [ ] Focused checks pass and affected project docs match implementation; unresolved design
  values/limits and integration-test evidence are reported honestly.

## Suggested work order within this issue

1. Resolve identity mechanism and remaining operational policy details; document contracts.
2. Tenant/admin authorization and RLS-safe release/activation/audit persistence.
3. Explicit dependency injection, frozen profiles and durable conversation pinning.
4. Stable turn/effect identity, recovery, bounded fallback and typed public feedback.
5. Admin screens over authorized services; Git/LangSmith import/export synchronization.
6. Local execution tracing and per-tenant usage/budget reporting, independent of scoring.
7. Functional/regression verification and documentation; evaluation runs remain deferred.

Keep delivery slices reviewable. This issue is the umbrella objective; do not mark it complete
after shipping only a mock admin screen or a configuration schema without working continuation.

## Next-agent code map (existing files unless explicitly marked proposed)

| Area | Start here | Why |
|---|---|---|
| Request identity | `src/auth/resolve-identity.ts` | Pilot tenant mapping; missing admin role gate |
| Middleware / app entry | `proxy.ts`, `app/page.tsx`, `app/actions/auth.ts` | Authenticated route/session entry |
| Roles, tenant schema | `migrations/1777045764915_enums.js`, `1777046925701_tenants-and-users.js` | Existing admin/member roles and organization IDs |
| RLS and context | `migrations/1777047967923_app-schema-and-helpers.js`, `1777048001111_rls-policies.js`, `src/db/with-transaction.ts` | Tenant/user policy and privileged-context limitations |
| Repository entry | `src/repos/index.ts`, `models.ts`, `conversations.ts`, `messages.ts`, `llm-calls.ts`, `agent-tasks.ts` | Persistence boundaries and current audit/domain records |
| Composition | `src/core/orchestrator/runtime-config.ts`, `runtime.ts` | Inject providers/profiles instead of per-tenant singleton mutation |
| Providers | `src/services/llm/{index,types,model-config,openrouter-provider,anthropic-provider}.ts` | Current selected provider, protocol translation and capability checks |
| Prompts | `src/adapters/chat-input-adapter.ts`, `chat-output-adapter.ts` | Embedded builders, version labels, generation/history settings |
| Prompt inputs | `agents/logo-agent/agent-card.json`, `src/core/orchestrator/agent-registry.ts` | Dynamic hints and field schemas also need release identity |
| Controller/UI | `app/actions/chat.ts`, `components/CreaMype.tsx` | Partial-turn persistence and current exception-string handling |
| Domain/recovery | `src/core/orchestrator/{orchestrator-core,merge,planner,postgres-store}.ts` | Deterministic boundaries, mutable maps, concurrency/recovery seams |
| Agent effects | `src/transport/*`, `src/workers/logo-agent-worker.ts`, `agents/logo-agent/handler.ts` | Stable dispatch IDs and no duplicate image generation |
| Product audit | `src/services/llm-logger.ts` | Extend or compose safe attempt/usage trace recording |
| Public events | `app/api/agents/stream/route.ts`, `src/core/agent-types.ts` | Authorized feedback; preserve existing public contract compatibility |
| Future evals | `evals/{extractor,responder}.eval.ts`, `_support/setup.ts`, `evaluators/judge.ts`, `datasets/*` | Existing component harness, mocked product audit, separate judge overhead |

**Proposed, not existing:** admin routes/components; release/profile/activation repositories;
platform/tenant permission service; execution resolver; provider registry; fallback policy;
trace sink and evaluator contracts. Choose concrete paths following repository conventions;
the table is not evidence that those modules already exist.

## Existing focused tests and verification guidance

Read `docs/agents/testing.md` before tests. Relevant current tests include:

- `app/actions/__tests__/chat.test.ts`
- `src/adapters/__tests__/chat-input-adapter.test.ts`
- `src/adapters/__tests__/chat-output-adapter.test.ts`
- `src/services/llm/__tests__/provider.test.ts`
- `src/services/__tests__/llm-logger.test.ts`
- `src/core/__tests__/cross-tenant-isolation.test.ts` (inspect pending/todo coverage)
- `src/core/__tests__/orchestrator-smoke.test.ts`
- `src/workers/__tests__/logo-agent-worker.test.ts`
- `src/repos/__tests__/*` for actual SQL/RLS integration.

Run only affected files with `npx vitest run <path>` using fake provider responses. Typecheck
with `npx tsc --noEmit --incremental false`; lint affected files; run `git diff --check`.
Do not reflexively run the full suite. Real DB migrations/integration tests require agreement;
fake tests alone do not prove RLS. No `npm run eval*`, real model/image calls or cloud uploads.

Cover two tenants plus two members in one tenant; role changes/revocation; forged IDs; release
activation races; provider switches/disablement; missing credentials/model retirement; fallback
capability mismatch/exhaustion; partial success and duplicate turns; restart; unknown costs.
Existing `it.fails` tests document unresolved desired behavior, not readiness. Convert relevant
cases to normal passing tests only when their underlying defects are fixed.

## Related work and local context

- Parent: [KAN-22 — Administration, traceability and usage control](https://matyaslopz.atlassian.net/browse/KAN-22).
- [KAN-69](https://matyaslopz.atlassian.net/browse/KAN-69): deployment-wide OpenRouter/direct
  Anthropic selection and model overrides. This objective extends that work; no status change implied.
- Reuse/coordinate [KAN-41](https://matyaslopz.atlassian.net/browse/KAN-41) and
  [KAN-66](https://matyaslopz.atlassian.net/browse/KAN-66) for identity/admin boundaries;
  [KAN-42](https://matyaslopz.atlassian.net/browse/KAN-42) for durable traces;
  [KAN-43](https://matyaslopz.atlassian.net/browse/KAN-43) for budgets/reservations; and
  [KAN-60](https://matyaslopz.atlassian.net/browse/KAN-60) for the deferred evaluation baseline.
- Related recovery/isolation work: [KAN-17](https://matyaslopz.atlassian.net/browse/KAN-17),
  [KAN-18](https://matyaslopz.atlassian.net/browse/KAN-18),
  [KAN-55](https://matyaslopz.atlassian.net/browse/KAN-55),
  [KAN-57](https://matyaslopz.atlassian.net/browse/KAN-57),
  [KAN-58](https://matyaslopz.atlassian.net/browse/KAN-58), and
  [KAN-63](https://matyaslopz.atlassian.net/browse/KAN-63). These existing issues were verified
  as To Do on 2026-10-18; no formal blocking links, status changes or reparenting are implied.
- Local design: `docs/agents/ai-configuration-admin-design.md`.
- Local prior audit: `docs/agents/langgraph-migration-audit-2026-10-18.md`.
- Local known bugs: `docs/agents/known-bugs/README.md`, especially restart ownership,
  announcements drained before response, agent-state lost updates, and actor-cache authorization.
- Read `AGENTS.md`, `docs/agents/{architecture,data-structures,database,stack,testing}.md`,
  and applicable `.claude/rules/*`. Query Graphify first for call paths, then inspect exact source.
- The local docs/rules and `graphify-out/` are gitignored; never force-add them. This issue body
  is deliberately self-contained so a different checkout/agent can still implement it.
- Current working tree includes substantial staged/unstaged/untracked work. Inspect current
  diffs before edits, preserve others' changes, and do not reset/stash/stage/commit by default.
  `pipeline/specs.md` describes earlier KAN-69 work; do not overwrite it with this objective.
- Client-facing copy uses neutral Latin-American Spanish with tuteo, never voseo. Bump prompt
  versions if wording/schema changes and update affected docs; do not run paid evals yet.

## Open operational details (refine during implementation, not grounds to reopen settled choices)

- WorkOS organization/membership mapping and platform-admin identity source; personal-tenant
  provisioning remains a separate existing open decision.
- Budget windows, reservation/accounting, exhaustion behavior and concrete attempt/cost ceilings.
- Trace-content permissions, retention/deletion and export boundaries. Default to existing
  ownership restrictions until explicitly expanded; no production-content cloud export.
- Legacy migration action and compatibility/retirement support policy for old executable code.
- Deployment topology and recovery ownership where they affect safe concurrent continuation.

## Out of scope

Running evaluations now; choosing a quality rubric; launching new logo/label/marketing
capabilities; a mandatory LangGraph rewrite; tenant-supplied secret onboarding; enabling
production LangSmith content uploads; unrelated backlog changes or deployment.
