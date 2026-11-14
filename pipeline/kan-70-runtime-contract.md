# KAN-70 runtime configuration contract

`AiConfigService` in `src/services/ai-config/service.ts` is the authorized management
boundary. It checks resolved tenant/platform identity before every operation, while repository
transactions repeat authorization. Drafts are validated inert JSON; imports are never evaluated
as code. Shared tenant overrides use exact JSON-pointer paths recorded on the lineage snapshot.

`AiConfigRuntime.runPurpose(identity, { conversationId, turnId, ownerToken, purpose }, operation)`
loads only the conversation's local pinned release and validates its canonical content hash,
runtime version range, code fingerprint and dependency fingerprint before resolving a profile.
Frozen and retired pins remain usable. A draft is never executable. `operation` receives an
immutable `{ model, behavior }` pair, where generation settings are copied from the selected frozen
profile and the behavior snapshot is purpose-specific.

The provider registry uses explicit frozen provider/model IDs and opaque references
`platform.openrouter` / `platform.anthropic`; it does not consult or mutate `LLM_PROVIDER` during
requests. Credentials remain server-side. Trusted provider capabilities and model limits are
code-owned. OpenRouter Gemini 2.5 profiles use the documented 1,048,576-token input context and
65,536-token output cap; Anthropic profiles use the documented 1,000,000-token context and
128,000-token output cap. Extractor profiles require forced tool use and JSON-schema support.
Anthropic 5.5 profiles freeze `temperature: 1`; the provider's documented model behavior rejects
non-default sampling values ([Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide),
[Sonnet 5.5 overview](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)). OpenRouter
profiles retain their frozen behavior temperatures. Unsupported settings fail before the paid
call rather than being silently dropped.

Each purpose has a durable maximum of two attempts, enforced by the turn repository as well as
the manifest validator. Only provider unavailability, rate limiting, unavailable credentials,
explicit tenant disablement, or an unavailable model may select the single configured fallback.
Invalid credentials, request rejection, authorization/content refusal, local parsing errors, and
ambiguous timeouts do not retry. Attempt reservation and actual rendered request content are
persisted before the provider call. The provider completion, safe failure category/status, token
counts and nullable cost are persisted afterward. If evidence persistence fails after a provider
call, the runtime returns an ambiguous evidence failure and does not fall back. Cost remains null
when unknown; no monetary budget or retention period is inferred here.

`createBaselineDraft()` captures the active `logo-agent` card, current adapter behavior, planner,
merge, provider and handler source identity plus the lockfile/dependency identity. In source
deployments it hashes the complete allowlisted source set and fails if any file is missing. In
source-less deployments explicit `AI_CONFIG_CODE_FINGERPRINT` and
`AI_CONFIG_DEPENDENCY_FINGERPRINT` build values are required. The selected deployment provider
and its purpose-specific model environment values seed the draft; creating it never publishes or
activates it. Runtime operation should use build fingerprints supplied by the deployment, because
standalone output may not contain source files.

The platform credential capability currently recognizes only `OPENROUTER_API_KEY` and
`ANTHROPIC_API_KEY`; tenant availability flags are `AI_CONFIG_OPENROUTER_ENABLED` and
`AI_CONFIG_ANTHROPIC_ENABLED` (`true`/`false`, default enabled). Runtime version and deployment
fingerprint variables are `AI_CONFIG_RUNTIME_VERSION`, `AI_CONFIG_CODE_FINGERPRINT`, and
`AI_CONFIG_DEPENDENCY_FINGERPRINT`.

Manifest export and SHA-256 use recursive compact JSON: object keys sort by UTF-8 byte order
(matching PostgreSQL C collation), arrays keep their order, and finite numbers use plain decimal
notation. Database `app.canonical_json(jsonb)` must match those bytes exactly before it accepts a
frozen hash.

Git export is a local canonical JSON download and its audit status means only that the content was
prepared for the caller; it does not claim a remote push. LangSmith prompt sync is explicit and
platform-admin initiated, uses pinned prompt commit IDs and template-only data, and never includes
production conversation prompts or traces. Remote prompt data remains inert validated JSON; no
Runnable or executable prompt loader is used. Sync retries create a new audit operation linked to
its parent operation, and remote latest pointers never select runtime behavior. Publication uses
private content-addressed names derived from the frozen manifest hash and records the commit returned
by `Client.pushPrompt`. Imports use the raw `pullPromptCommit` API with a caller-selected fixed
commit and `includeModel:false`; the result becomes a validated draft and is never activated.

Frozen manifest validation rejects recognizable platform/API-token literals in every string value.
Before persistence, trace evidence redacts known token patterns and configured platform key values;
the model receives the original request unchanged. Pattern scanning cannot identify arbitrary
secret material.
