# KAN-43 — Usage limits before calling models

Status: **approved 2026-11-02** (owner decision; values are not derived from the thesis's
USD 0.48 per-brand estimate).

## Limits

All values live in one module, `src/services/usage/policy.ts` (`USAGE_POLICY`). Change them only
there. There are no per-tenant overrides.

| Limit | Value | Window |
|---|---|---|
| Tenant budget | USD 30 | calendar month, America/Lima |
| LLM calls per user | 60 | rolling 60 minutes |
| Images per user | 15 | calendar day, America/Lima |
| Characters per chat message | 4,000 | per message (Unicode code points) |

## How it is enforced

- **One gateway** (`src/services/usage/gateway.ts`, `runWithUsage`) wraps every paid provider
  call. It is hooked in at the two existing chokepoints:
  - the LLM attempt wrapper, `src/services/ai-config/execution.ts`. Every Extractor or Responder
    attempt, retry, and fallback is its own call.
  - `ImageGeneratorService.generate` (fal). The production generator fails closed when a request
    carries no usage scope.
- **Reserve, then reconcile.** Before the call, the gateway reserves the estimated cost in
  `usage_reservations`. It does this in one transaction, under a per-tenant advisory lock, so
  parallel calls cannot overspend. After the call, the row is settled with the real cost:
  - LLM: provider-reported tokens × list price.
  - Image: the flat image price.

  "Committed spend" is the sum of open reservations (at their estimate) and settled rows (at
  their real cost).
- **Failures are counted.** A call that fails is still one call against the per-user limits. It is
  settled as follows:
  - USD 0 when the provider surely did not bill: a typed, non-ambiguous provider error, or a typed
    image error other than a timeout.
  - The estimate when the outcome is unknown: timeouts and untyped errors.

  A refused or invalid completion is settled at its real cost. If settlement is lost, the row
  stays reserved at its estimate, which is conservative.
- **Preflight.** Before a chat turn is claimed, the server action checks room for 2 LLM calls
  (Extractor + Responder) and the input cap. A deliverable command checks room for 1 image before
  any task row exists: generate, iterate, and retry. Approve and cancel are not checked. A denied
  request leaves no turn and no task, only a `denied` ledger row. A retry of a chat request that
  was already answered skips the check and gets its stored reply, even over a limit.

## Exhaustion behavior

A denied call never reaches the provider, writes a `denied` row, and shows the user:

| Reason | Message |
|---|---|
| `tenant_budget` | «Alcanzaste el límite de uso de este mes. Avísale al administrador de tu organización.» |
| `user_llm_hourly` | «Alcanzaste el límite de mensajes por hora. Espera un momento e inténtalo de nuevo.» |
| `user_image_daily` | «Alcanzaste el límite de imágenes de hoy. Podrás generar más mañana.» |
| `input_too_long` | «Tu mensaje es demasiado largo. Escribe hasta 4000 caracteres.» |

The admin usage view shows the month's committed spend against the budget, and whether the
budget is exhausted.

## Known limits of this version

- **Prices are hand-typed list prices** (`PRICING_VERSION`), not invoices. Two rules apply:
  - Models missing from the table are charged a conservative default of USD 5 / USD 25 per
    million tokens.
  - Since 2026-11-03 the pilot runs on Claude: `claude-sonnet-5-5` (USD 2 / 10) and
    `claude-haiku-5-5` (USD 0.10 / 0.50 up to 100k-token prompts) from public list prices.
    Images use fal FLUX.2 [dev] at USD 0.012 per megapixel, reserved as USD 0.03 per image
    (an edit also bills its reference image).

  Replace these with provider-reported costs when KAN-42 lands. Every ledger row carries the
  conversation, turn, attempt, and agent-task ids for that correlation.
- **Two edge cases:**
  - A worker-side image denial is possible when two commands race past the preflight. It fails
    the task as `usage_limited` (transient), and the card shows the image-limit message. The task
    error does not carry the denial reason, so a rare tenant-budget denial there also shows the
    image message. The next command's preflight shows the exact reason.
  - The Responder can be denied after the turn's effects are committed. That turn fails like any
    provider failure.
- **Evals bypass the gateway.** The Extractor and Responder adapters fall back to an ungated
  provider when no execution is passed. Only evals and tests do that; `chatAction` always passes
  one.
