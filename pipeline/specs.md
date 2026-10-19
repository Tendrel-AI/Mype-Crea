# KAN-69 implementation specification

## Active assignment: KAN-70

The KAN-69 specification below is historical context. The active implementation is KAN-70,
whose approved requirements and user decisions are in `pipeline/kan-70-specs.md` and the Jira
issue mirrored in `pipeline/jira-ai-admin-issue.md`. Follow those documents for this assignment.

Only specialized **coder** subagents using **gpt-6-luna** may execute implementation work.
The primary agent guides at feature level and reviews outcomes; it does not edit application
code or prescribe implementation mechanics. Preserve all existing workspace changes.

The current implementation is unfinished. In particular, an automated formatting pass
corrupted SQL in `src/repos/ai-config.ts` and `src/repos/ai-turns.ts`; these files require a
correctness review and repair before delivery. No migration or real database test has run.
Complete KAN-70 and verify its acceptance criteria, rather than assuming prior passing
offline checks prove the integrated feature. Follow the repository's approval requirements
for database operations. Do not stage, commit, deploy, run paid APIs/evals, or change Jira.

---

Planner: primary Codex agent. Scope approved by the user on 2026-10-18.
Issue: https://matyaslopz.atlassian.net/browse/KAN-69

## Outcome

One deployment-level `LLM_PROVIDER=openrouter|anthropic` switch controls every active non-image LLM caller, including eval judge/setup. Undefined defaults to OpenRouter. Restart applies changes. Only the selected provider key is required. Unknown/empty provider values and missing/blank selected keys produce clear errors without secrets or silent fallback. Images continue using fal.ai independently.

## Model routing

- OpenRouter: keep extractor `google/gemini-2.5-flash`, responder `google/gemini-2.5-pro`, and existing eval judge default/override behavior.
- Direct Anthropic: Haiku for extractor/auxiliary judge, Sonnet for main responder. Official model overview verified by planner: https://platform.claude.com/docs/en/models/overview lists `claude-haiku-5-5` and `claude-sonnet-5-5`. Verify relevant request capabilities in official model/API docs before finalizing request options; newer models can restrict temperature/thinking/tool_choice. Do not guess incompatible fields. These are model-family choices already authorized by user.
- Keep EVAL_JUDGE_MODEL as a selected-provider-valid override; reject obviously incompatible OpenRouter slugs in Anthropic mode. Provide provider-aware judge default. Do not activate stub agents or change planner decisions.

## Implementation boundaries

- Own `src/services/llm/**`, `src/services/llm-logger.ts`, adapter LLM call boundaries, eval judge/setup/metadata, shared LLM fixtures and focused tests, `.env.example`, README provider instructions, package dependency files if necessary, and impacted local docs/rules/AGENTS references.
- Shared interface must no longer require a concrete OpenAI SDK client. A narrow completion request/response protocol retaining the currently consumed message/tool/usage shapes is acceptable, with an Anthropic Messages translation wholly inside its provider. Avoid broad unsafe SDK casts. Explicitly reject unsupported request shapes rather than silently dropping them. Preserve forced function calls, schema validation, stop/truncation reasons, token limits and usage. Preserve current prompts/schema wording and versions unless genuinely changed.
- Prefer official `@anthropic-ai/sdk` with LangSmith `wrapAnthropic` (https://docs.langchain.com/langsmith/trace-anthropic; `langsmith/wrappers/anthropic`) when compatible with installed LangSmith. A small typed direct Messages HTTP adapter is acceptable if dependency constraints warrant, but must retain timeout/error handling and dev-only tracing. No OpenRouter-compatible endpoint shortcut for direct Anthropic.
- Product LLM calls continue through withLlmLogging. Structured logs must include provider, purpose and effective model, including error paths; retain current tenant context, usage persistence and swallowed audit-persist failures. Existing llm_calls DB has model/revision/prompt/usage but no provider/purpose fields: do not add SQL/schema changes for this task; retain durable model/usage and provider/purpose in structured logs. Judge remains eval-only, outside product audit rows.
- Both providers use LangSmith only when LANGSMITH_TRACING=true and NODE_ENV is not production. Test production guard with wrappers mocked, without upload.
- Use normalized effective model from response for logs/audit when available. Normalize Anthropic input/cache/output usage appropriately; document any necessary distinction.
- No pure core/planner/merge, provider-selection UI, image generation implementation, database, deployment or unrelated bug fixes. A narrow update in `components/CreaMype.tsx` may recognize both provider credentials and invalid provider configuration with a neutral Spanish service-configuration error; do not expose environment/key names in business-user messages. Reuse existing fakes and reset hooks.
- Keep the common tool-choice subset consistent between providers (auto/none/required/named function). Support or explicitly reject extra fields in messages/function tools rather than silently dropping them. Format new interfaces/functions in readable multiline repository style.
- Any synthetic continuation turn needed for Anthropic empty/assistant-ending histories must use neutral Latin-American Spanish. Judge provider selection must agree with the cached provider used for the actual request, and explicit blank judge-model overrides must be rejected.

## Verification / documentation

- Read docs/agents/testing.md and applicable .claude/rules before any test.
- Extend existing test files for existing areas. New provider/config/judge tests are appropriate where absent. Cover both modes, default, independent credentials, invalid config, model mapping, real request translation with fake SDK responses, structured tool calls, text responses, truncation/usage and upstream errors, provider-aware eval setup and judge, tracing guard and image independence.
- Focused Vitest files only, no integration tests, live paid APIs, uploads or full eval suites. Typecheck with incremental disabled to avoid touching the user's tsbuildinfo. Lint affected files; report unrelated baseline failures separately.
- Update .env.example and relevant README setup instructions, docs/agents architecture §2.8/tracing, stack, testing, contracts docs and path rules if invalidated; do not resolve unrelated TBDs. Local-only ignored docs must stay ignored.
- User workspace contains substantial staged and unstaged edits, including overlapping files. Preserve all existing changes. Capture/review pre-existing diffs for overlapping files before editing. Do not reset/stash, stage, commit, push, create PRs, change Jira, or revert others' work. Report changed files, checks, limitations and any follow-up needed.

## Follow-up: model configuration from environment (user requested)

- Add optional `OPENROUTER_EXTRACTOR_MODEL`, `OPENROUTER_RESPONDER_MODEL`, `ANTHROPIC_EXTRACTOR_MODEL`, and `ANTHROPIC_RESPONDER_MODEL`. Preserve all four current model IDs as defaults when the corresponding variable is absent. Show concrete default assignments in `.env.example` so users can edit them. Keep existing `EVAL_JUDGE_MODEL` for judge selection and explain it alongside the four variables.
- Resolve/capture a provider's models once during construction, matching the restart-based provider switch. Read/validate only the selected/constructed provider's overrides. Trim values; reject explicit blank/whitespace values and obvious cross-provider format errors with clear configuration errors that name the offending variable, never secrets. OpenRouter IDs use provider/model slugs; Anthropic IDs use direct `claude-...` model identifiers. Do not query live services to validate model existence.
- Keep request capability guards (e.g. forced tools unsupported on Sonnet 5.5) and explain that overrides must support the purpose's capabilities. Avoid silently dropping overrides or rewriting them to default models. The user may override the model family; do not enforce Haiku for extractor configuration merely because that is the default. Image configuration remains independent.
- Own provider config code/tests plus `.env.example`, README and impacted local docs. Primary agent owns safely adding missing model entries to `.env.local`, without reading secrets into output or changing any existing values. Do not edit `.env.local` in coder work.
- Extend existing provider test file: independent per-purpose and per-provider values, defaults, captured configuration/restart semantics, inactive-provider invalid overrides ignored, trimmed values, invalid/blank formats, and actual request model preservation with mocked network. Reuse existing tests; no live APIs/evals/DB.
- Run just the provider test file and focused lint for changed code. Primary agent will run final typecheck. Do not change Jira, commit, stage or push.
