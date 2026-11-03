[← Features](README.md)

# Usage limits before model calls

## What it does

Every paid call checks the limits before it reaches a provider. This covers each LLM call (Extractor, Responder, fallback, the name agent) and each image generation. Over a limit, the user gets a clear Spanish message and no provider is called. After the call, the real cost replaces the estimate.

## How it works

1. **Policy.** `src/services/usage/policy.ts:USAGE_POLICY` is the only place limits live:
   - USD 30 per tenant per calendar month (America/Lima);
   - 60 LLM calls per user per hour;
   - 15 images per user per day;
   - 4,000-character inputs.
   The same file holds the prices (`PRICING_VERSION`, `IMAGE_PRICE_USD`) and the user messages (`usageLimitMessage`).
2. **Reserve, call, settle.** `src/services/usage/gateway.ts:runWithUsage` calls `usage.reserve`, which inserts an estimated row into `usage_reservations` under a per-tenant advisory transaction lock. Concurrent calls therefore cannot overspend. On denial it throws `UsageLimitError` and no provider is called. Otherwise it calls the provider and then `settle`s the row with the actual cost (or the failure cost).
3. **Hook points.**
   - `captureAttempt` in `src/services/ai-config/execution.ts`: the new category `usage_limited` is never eligible for fallback.
   - `usageGatedCompletion` (same file), shared by `captureAttempt` and `src/services/llm/agent-completion.ts:AgentLlmService` (KAN-31 names). An agent call is charged to the conversation owner, resolved from the task; it fails closed when the owner cannot be found.
   - `ImageGeneratorService.generate`.
4. **Early checks.**
   - `app/actions/chat.ts` runs `usage.preflight` before the turn. It skips the check when the request was already answered, so a retry still returns the stored reply.
   - `app/actions/deliverable-command.ts` runs the check before Generar, Iterar and Reintentar: kind `llm` for `name-agent`, `image` for the rest.
   - The cards map `lastFailure.errorKind = usage_limited` to the image-limit message, or to the LLM-limit message on the name card (`components/crea-mype/failure-copy.ts`).
5. **Table.** `migrations/1792800006000_usage-reservations.js`: tenant-scoped, RLS forced, no DELETE for the app role.

## Key rules / invariants

- **No provider call without a reservation.** Enforced by `src/services/ai-config/__tests__/execution.test.ts`, `src/services/llm/__tests__/agent-completion.test.ts`, `src/services/image/__tests__/generator.test.ts` and `src/services/usage/__tests__/policy.test.ts`.
- **Concurrency and RLS.** Enforced by `src/repos/__tests__/usage-reservations.integration.test.ts` (throwaway Postgres only).
- **Controllers.** Enforced by `app/actions/__tests__/chat.test.ts` and `deliverable-command.test.ts`.

## Decisions

[`pipeline/decisions/KAN-43-usage-limits-policy.md`](../../pipeline/decisions/KAN-43-usage-limits-policy.md): a moderate budget; deny, then reserve and reconcile (owner, 2026-11-02).

## Limits

- Some models are missing from the price table and get the default price (USD 5/25 per million tokens).
- The fal.ai price of USD 0.08 is unverified.
- A reservation whose settlement was lost stays `reserved` and keeps counting; nothing cleans it up.
- Evals bypass the gateway.

## See also

[09-ai-configuration.md](09-ai-configuration.md) · [03-deliverable-lifecycle.md](03-deliverable-lifecycle.md)
