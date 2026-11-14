# KAN-69 A6: llm_calls provenance validation (2026-10-25)

Branch `feat/kan-69-llm-call-provenance` (base `developer` at `f7b067b`). Mocked LLM only; no
eval, real provider call, `.env.local`, or shared/dev/Railway database was used.

## Change

- Migration `1792720000000_llm-calls-provenance`: adds `llm_calls.provider` (CHECK IN
  `openrouter`, `anthropic`) and `llm_calls.purpose` (CHECK IN `extractor`, `responder`), the
  same values as `ProviderId`/`Purpose` and the existing `ai_turn_attempts` checks. Existing rows
  are not backfilled (provider could only be guessed from the model ID shape, purpose not at
  all), so they stay NULL. A NOT VALID check `llm_calls_provenance_required` makes both columns
  mandatory for every new or updated row without rewriting history. RLS (ENABLE + FORCE),
  policy `llm_calls_tenant`, grants and indexes are unchanged. `down` drops the check and both
  columns.
- `LlmCallInsert` and `llmCallsRepo.record` require and insert `provider` and `purpose`.
- `withLlmLogging` takes `LlmCallContext` (`LlmLoggingContext` & required `provider`,
  `purpose`) and records them; the `LLM_PROVIDER` fallback and the `'responder'` default were
  removed. Extractor and responder adapters already pass the resolved model's provider, so a
  fallback attempt is recorded under the fallback profile's provider.
- Judge calls stay outside `llm_calls` (eval cost, per A6). Failed attempts are not billed rows;
  their failure category stays in `ai_turn_attempts`.

## Disposable PostgreSQL runs

Both runs used a fresh `postgres:16-alpine` container with a unique name, `--rm`, `--tmpfs`
data directory, a random `127.0.0.1` port, a random superuser password, and a random
`app_user` password set after migrations. Containers were removed at the end (verified with
`docker ps -a`).

| Step | Fresh install | Upgrade |
|---|---|---|
| Base | none | 18 `origin/developer` migrations from `git archive origin/developer migrations`, then one legacy `llm_calls` row without provenance |
| Apply branch migrations | 19 applied, last `1792720000000_llm-calls-provenance` | same |
| `down 1` then `up` | columns removed, then re-added | same; legacy row survived both directions |
| Schema | `provider`, `purpose` text, nullable; `llm_calls_provider_check`, `llm_calls_purpose_check` validated; `llm_calls_provenance_required` NOT VALID | same |
| RLS / grants | `relrowsecurity` and `relforcerowsecurity` true; policy `llm_calls_tenant` unchanged; `app_user` keeps SELECT, INSERT, UPDATE, DELETE | same |
| Legacy row | n/a | provider NULL, purpose NULL, tokens 7/8 preserved |
| `node scripts/ci-db-check.mjs` | passed | passed |
| `llm-calls.integration.test.ts` + `cross-tenant-isolation.integration.test.ts` | 6 passed, 0 skipped | 6 passed, 0 skipped |

The `llm_calls` integration suite (5 tests) covers user and system rows, read-back of
provider/purpose/model/tokens under the tenant, rejection of an unknown provider
(`openai`), an unknown purpose (`judge`), and new rows missing either column, and the foreign
tenant RLS WITH CHECK rejection.

## Local checks

- `npx tsc --noEmit --incremental false`: passed.
- ESLint on all changed files: passed.
- `npx vitest run src/services src/repos --exclude "**/*.integration.test.ts"`: 19 files,
  120 tests passed.
- `npx vitest run src/adapters/__tests__/chat-input-adapter.test.ts src/adapters/__tests__/chat-output-adapter.test.ts`:
  65 passed.

## Not verified / residual

- The adapters still default to `'openrouter'` when a resolved model has no `provider`
  (`resolved.provider ?? 'openrouter'` in both chat adapters). No real path reaches it: both
  providers and the KAN-70 registry always set `provider`, and frozen execution rejects a model
  without one. `src/adapters/chat-input-adapter.ts` was out of scope for this branch.
- A provider call that consumes tokens and then fails inside the client wrapper produces no
  `llm_calls` row; its usage is kept on the `ai_turn_attempts` row.
- The NOT VALID check also rejects an UPDATE of a legacy row that leaves provenance NULL. The
  repository exposes no update, so this only affects manual SQL.
