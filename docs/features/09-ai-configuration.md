[← Features](README.md)

# AI configuration and model execution

## What it does

Each conversation runs on a frozen, versioned AI release (which model and prompts serve the
Extractor and the Responder), so its behavior does not change mid-conversation when an operator
changes settings. If the primary provider is unavailable, one approved fallback takes over and
the turn records a notice. Every successful model call is logged with its provider, model and
tokens, and tenant admins see a usage summary. Logo images always come from fal.ai.

## How it works

1. **Release manifest.** `src/services/ai-config/manifest.ts` defines a portable, non-executable
   release: model profiles per purpose (`extractor`, `responder`), provider (`openrouter` |
   `anthropic`), the fallback chain, and the frozen adapter behavior (prompt templates,
   tool/schema settings, versions; `src/services/ai-config/adapter-behavior.ts`). Its canonical
   JSON hash is its identity, and frozen rows cannot be edited (database triggers).
2. **Capture and activate.** In `/admin/ai` (`app/admin/ai/page.tsx`,
   `components/AiConfigurationAdmin.tsx`, actions in `app/actions/ai-config.ts`) an admin
   captures a baseline draft (`src/services/ai-config/baseline.ts:createBaselineDraft`, primary
   profile from `LLM_PROVIDER`), validates, diffs, freezes and activates it for the tenant, or a
   platform admin publishes a shared release / platform default. Business rules live in
   `src/services/ai-config/service.ts:AiConfigService`; storage in `src/repos/ai-config.ts`.
3. **Pin.** A new conversation pins the active frozen release in the same transaction that
   creates its row (`ensurePinnedConversation` in `src/repos/conversations.ts`). Shared or
   platform releases are first copied into an immutable tenant-local release, so pins never
   point across tenants.
4. **Execute.** `app/actions/chat.ts:chatAction` builds an
   `src/services/ai-config/execution.ts:AiConfigRuntime` and calls `runPurpose` for each stage.
   It resolves the pin, validates its hash and runtime compatibility, then tries the primary
   profile and at most the configured fallbacks
   (`src/services/ai-config/provider-registry.ts:ProviderRegistry` builds the clients and checks
   context and output limits). Only `provider_unavailable`, `rate_limited` and
   `model_unavailable` allow a fallback; ambiguous outcomes, refusals and schema failures do
   not. Each attempt is recorded in `ai_turn_attempts`; a used fallback stores an
   `approved_fallback_used` notice with the turn. `AI_CONFIG_<PROVIDER>_ENABLED=false` is a
   platform kill switch.
5. **Providers.** `src/services/llm/openrouter-provider.ts` (OpenAI SDK) and
   `src/services/llm/anthropic-provider.ts` (Messages API). Model-id shapes are checked in
   `src/services/llm/model-config.ts` before any network call. `src/services/llm/index.ts:getProvider`
   (driven by `LLM_PROVIDER`) serves evals and the judge, not chat turns.
6. **Images.** `src/services/image/index.ts:getImageGenerator` →
   `src/services/image/generator.ts:ImageGeneratorService` →
   `src/services/image/fal-provider.ts:FalImageProvider` (`FAL_KEY`); `classifyFalError` maps
   vendor errors to typed task-error kinds.
7. **Call log.** Both adapters wrap each completion in
   `src/services/llm-logger.ts:withLlmLogging`, which writes one `llm_calls` row
   (`src/repos/llm-calls.ts`) with the effective provider, purpose, model, prompt version,
   tokens and latency. Cost is computed at read time, never stored.
   Agent LLM calls (KAN-31 `name-agent` and KAN-32 `tagline-agent`, purpose `naming`) are not chat turns: they skip the
   release runtime (no pinned profile, no `ai_turn_attempts` row; the model is the provider's
   default for `naming`), but go through the same KAN-43 gate (`usageGatedCompletion`) and the
   same call log (`src/services/llm/agent-completion.ts`).
8. **Usage summary.** `src/repos/ai-turns.ts` aggregates `ai_turn_attempts` per tenant (and
   optionally per user and period) through `src/repos/usage-summary.ts:summarizeUsage`, exposed
   to tenant admins by `src/services/ai-config/admin-service.ts:AiAdminService` (`getUsage`) on
   `/admin/ai`.

## Key rules / invariants

- **A conversation uses its pinned release, not the deployment default.** Enforced by
  `src/services/ai-config/__tests__/execution.test.ts` ("uses the pinned profile regardless of
  the deployment default…").
- **At most one approved fallback, and only for availability failures.** No retry after an
  ambiguous outcome or a successful paid call. Enforced by `execution.test.ts` ("does not repeat
  an ambiguous provider outcome", "does not fall back for refusal, truncation…", "never makes a
  paid request when request evidence cannot be written").
- **`llm_calls` records the provider that actually served the call, never `LLM_PROVIDER`.**
  Enforced by `src/services/__tests__/llm-logger.test.ts` and `execution.test.ts` (KAN-69 A6).
  A logging failure never breaks the turn (same test file).
- **Unknown cost stays unknown.** The summary reports `complete | partial | unknown |
  no_attempts`, and the budget as `within_budget | exhausted` against the KAN-43 limit, instead of inventing zeros. Enforced by
  `src/repos/__tests__/usage-summary.test.ts`.
- **Releases are inert, hashed and secret-free.** Enforced by
  `src/services/ai-config/__tests__/manifest.test.ts`.
- **Prompts in neutral Spanish with tuteo; bump the prompt version on any wording change.**
  Checked on real outputs by `responder.no_voseo` (`evals/evaluators/responder.ts`, paid).

## Decisions

- 2026-10-25 — KAN-70 wins over KAN-69: conversations keep their frozen release, `LLM_PROVIDER`
  applies only when a new baseline is captured, and the baseline's automatic cross-provider
  fallback stays. Audit: [`pipeline/kan-69-audit-2026-10-21.md`](../../pipeline/kan-69-audit-2026-10-21.md).
  Note: [`docs/operations.md`](../operations.md) §5 still lists this as pending.
- KAN-70 specs and contracts: [`pipeline/kan-70-specs.md`](../../pipeline/kan-70-specs.md),
  [`pipeline/kan-70-runtime-contract.md`](../../pipeline/kan-70-runtime-contract.md).
- 2026-10-04 — LangSmith tracing is dev-only (ignored when `NODE_ENV=production`), because prompts
  carry tenant business data.

## Limits & known gaps

- A fresh database has no release: a platform admin must capture, freeze and activate one before
  the first conversation, or new conversations fail.
- Monetary budgets and usage caps are enforced before each call ([13-usage-limits.md](13-usage-limits.md)).
- The admin usage summary reads `ai_turn_attempts`, so agent LLM calls (names) are not in it;
  they are in `llm_calls` and in the KAN-43 usage ledger.
- A turn whose provider request may have been accepted becomes `uncertain` after its lease
  expires; this is a recoverable report, not an exactly-once guarantee.
- The KAN-70 migration and repository integration test were not run against PostgreSQL when the
  feature landed. ⚠️ Unverified: whether they have been run since.

## See also

- [01-chat-turn.md](01-chat-turn.md) — where the runtime is called
- [10-admin-platform.md](10-admin-platform.md) — module rollouts of AI releases
- [11-operations.md](11-operations.md) — evals and their cost rules
