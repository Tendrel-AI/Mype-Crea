[← Features](README.md)

# Agents and transport

## What it does

Each deliverable (logo, tagline, label, social pack) is produced by a sub-agent. The agent
declares which facts it needs, so the chat knows what to ask. Three agents are live:
**logo-agent** turns the brief (business name, style, optional colors) into a logo image generated
by fal.ai, **name-agent** (KAN-31) proposes five business names, each with a one-line reason,
from the rubro, the style and the optional product, and **tagline-agent** (KAN-32) proposes five
taglines («Lema»), each with a one-line reason, from the approved name plus the same brief fields.

## How it works

1. **Agent Card.** Each agent is a folder under `agents/` with an `agent-card.json` and a `handler.ts`.
   The card (A2A shape, `src/core/orchestrator/agent-registry.ts:AgentCard`) declares:
   - `mypes:requirements` — required and optional fields, each with a Spanish `promptHint`
     shown to the user (see `agents/logo-agent/agent-card.json`: `business_name`,
     `style_keywords`, optional `color_palette`);
   - `mypes:deliverable` — the deliverable `kind` and `dependsOn` (the upstream kinds that must be
     approved first; the logo and the tagline declare `["business_name"]`, KAN-35/KAN-32);
   - `mypes:ui` — tab label, icon, display order (display only, never used for decisions).
2. **Registry.** `src/core/orchestrator/bootstrap-registry.ts:buildDefaultRegistry` registers
   cards with their handlers into `src/core/orchestrator/agent-registry.ts:AgentRegistry`, the
   core's only view of which agents exist. The Extractor asks for the union of the registered
   fields; the planner and the state function read requirements and dependencies from it.
3. **Dispatch.** Only a typed command dispatches ([03-deliverable-lifecycle.md](03-deliverable-lifecycle.md)).
   The core inserts the `agent_tasks` row and calls `IAgentTransport.dispatch`
   (`src/core/agent-types.ts:IAgentTransport`). The transport is chosen in
   `src/core/orchestrator/runtime.ts` (`REDIS_DISPATCH_AGENTS` = `logo-agent`, `name-agent`,
   `tagline-agent`, derived from `REDIS_WORKERS`). The task's `requirements_snapshot` holds the
   brief values, the approved upstream ids (`upstream_approvals`, KAN-35) and, for upstreams with
   a text value, `upstream_inputs` (`{ <kind>: { deliverableId, value } }`, KAN-32); the worker
   (`splitRequirementsSnapshot` in `src/core/refinement.ts`) and the core's local dispatch hand the
   last one to the handler as `A2AMessage.upstream`, never inside `requirements`:
   - `src/transport/redis-queue-adapter.ts:RedisQueueAdapter` publishes a `task_dispatch`
     wake-up (`dispatchWakeUp`) on `mypes:agent_task:dispatch:<agentId>`. Postgres
     `agent_tasks` is the queue; Redis only says "look now".
   - When `REDIS_URL` is unset, the same adapter and workers run over an in-process wake-up bus
     (`inProcessWakeUpBus` in `runtime.ts`, single process only), so a task settles exactly as
     with Redis: deliverables and the durable notice are written (KAN-82).
   - `src/transport/local-adapter.ts:LocalAdapter` runs the handler in-process
     (`queueMicrotask`) for registered agents without a worker (none today).
     `waitForSettlement` is the test barrier.
4. **Worker.** `src/workers/agent-worker.ts:startAgentWorker` runs one worker per entry of
   `REDIS_WORKERS` (`LOGO_WORKER`, `NAME_WORKER`, `TAGLINE_WORKER`: agent id, deliverable kind, log scope) inside the
   Next.js process, with or without Redis. On a wake-up it re-reads the row, skips rows addressed
   to another agent, claims atomically (`claimById` in `src/repos/agent-tasks.ts`: only a `pending`
   row of that agent), publishes `task_processing`, and runs the handler. Shared worker types are
   in `src/workers/_kit.ts`.
5. **Handler.** `agents/logo-agent/handler.ts:handler` builds the prompt
   (`buildLogoPrompt`, which appends an Iterar observation as a quoted note) and calls
   `src/services/image/index.ts:getImageGenerator` → `src/services/image/fal-provider.ts:FalImageProvider`
   (`blackforestlabs/flux-3/klein/text-to-image`, FLUX.3 Klein at 1024x1024, or `klein/edit-image` with reference images). It returns an A2A result
   (`src/core/agent-types.ts:A2ATaskResult`); it never touches the database.
   `agents/name-agent/handler.ts:handler` makes one forced tool call
   (`propose_business_names`, prompt `NAME_PROMPT_VERSION`) through
   `src/services/llm/agent-completion.ts:getAgentLlm`, which resolves the `naming` model purpose,
   reserves and settles the call against the conversation owner's KAN-43 ledger
   (`usageGatedCompletion`, shared with the chat's `captureAttempt`) and audits it in `llm_calls`.
   It returns five `text` artifacts; each one's metadata carries the rationale, the input values
   with a `sha256:` fingerprint per field (the brief has no per-field version), the card and
   prompt versions, provider, model and time.
   `agents/tagline-agent/handler.ts:handler` does the same with `propose_taglines`
   (`TAGLINE_PROMPT_VERSION` = `tagline-agent.v1`, same `naming` purpose). It reads the approved
   name from `message.upstream.business_name` and records it in `metadata.inputs.business_name`
   with its `sha256:` version and `deliverableId`; an input entry with a `deliverableId` is an
   upstream reference, so staleness follows the name approval, never the brief's `business_name`.
6. **Persist and settle.** The worker copies an image to the private bucket (text passes through)
   ([06-assets-storage.md](06-assets-storage.md)), then
   `settleTaskAndEnqueue` (`src/repos/ai-turns.ts`) atomically writes the deliverable, marks the
   task completed/failed, clears the dispatch marker and inserts the durable outbox event
   ([04-live-updates.md](04-live-updates.md)). Only then does it await the core's
   `onTaskSettled`.
7. **Recovery.** After the worker subscribes, `src/core/orchestrator/periodic-recovery.ts:startPeriodicRecovery`
   republishes due `pending` rows and reconciles missing completion events, every 60 s, at most
   100 rows per tenant per pass (code defaults in `runtime.ts`). A task stuck `in_progress` is
   never replayed automatically, because the paid image or LLM call may already have succeeded.

### Which agents are live

| Agent | Deliverable kind | Status |
|---|---|---|
| `logo-agent` | `logo` | Live: registered, Redis worker, fal.ai |
| `name-agent` | `business_name` | Live (KAN-31): registered, Redis worker, LLM (`naming` purpose) |
| `tagline-agent` | `tagline` | Live (KAN-32): registered, Redis worker, LLM (`naming` purpose), needs an approved `business_name` |
| `label-agent` | `label` | Stub: handler returns `not_implemented`; not registered |
| `social-agent` | `social_pack` | Stub: handler returns `not_implemented`; not registered |

## Key rules / invariants

- **Agents are reached only through `IAgentTransport`; the core never calls a handler.** This
  keeps local, Redis and future queue transports interchangeable. Enforced by
  `src/transport/__tests__/redis-queue-adapter.test.ts` and the transport-backed smoke test
  `src/core/__tests__/orchestrator-smoke.test.ts`.
- **The Redis message is a trigger, never trusted data.** The worker re-reads and claims the
  row; a malformed payload is dropped and a row for another agent stays `pending`. Enforced by
  `src/workers/__tests__/logo-agent-worker.test.ts` ("does not claim a non-logo task…",
  "skips when claimById returns null").
- **Handlers never write to the database or call vendor SDKs directly.** They go through
  `src/services/image` / `src/services/llm`; the worker persists. Enforced by
  `agents/logo-agent/__tests__/handler.test.ts` (fake generator),
  `agents/name-agent/__tests__/handler.test.ts`, `agents/tagline-agent/__tests__/handler.test.ts`
  (fake `IAgentLlm`) and code review.
- **A stub is never registered.** The planner offers the lexically first ready agent, so a stub
  could win and fail when the user taps Generar. Enforced by review only: no test pins the
  registry contents.
- **Settlement is atomic and awaited.** Deliverable, task status and outbox event commit
  together; a failed settlement leaves the row `in_progress` for operator review and announces
  nothing. Enforced by `src/workers/__tests__/logo-agent-worker.test.ts` ("atomically settles…",
  "contains a failing durable settlement…"), and without Redis by
  `src/core/orchestrator/__tests__/runtime.test.ts` (KAN-82).

## Decisions

- 2026-10-25 — KAN-64: dispatch happens only from typed commands.
  [`pipeline/decisions/KAN-64-dispatch-model.md`](../../pipeline/decisions/KAN-64-dispatch-model.md)
- 2026-10-25 — KAN-58: failures carry a typed `error.kind`, classified by
  `src/core/task-errors.ts:classifyTaskError`; the worker checks the agent before claiming.
- Recovery plan for stuck tasks: [`pipeline/kan-63-recovery-plan.md`](../../pipeline/kan-63-recovery-plan.md) (KAN-18).
- Deployment topology (worker inside the web process): [`pipeline/kan-62-topology.md`](../../pipeline/kan-62-topology.md).

## Limits & known gaps

- Adding an agent means a working handler, registration, a `REDIS_WORKERS` entry, a
  `deliverable_kind` enum value, and the card in `src/services/ai-config/baseline.ts` (`CARDS`).
- **A new card that shares brief fields changes the merged extractor fields** (owners, and
  requiredness when it requires a field another card leaves optional). Pinned AI releases keep
  working because `frozenFieldsInRegistry` (`src/adapters/chat-input-adapter.ts`) compares only
  each frozen field's name and hint: the prompt is rendered from the frozen fields, and owners
  and the live required flag only drive routing and the planner. Changing an existing field's
  hint still breaks releases pinned before the change.
- The name and tagline prompts (`name-agent.v1`, `tagline-agent.v1`) have no real-model eval yet;
  only fakes test them.
- `upstream_inputs` carries only inline text values; an agent that needs an image upstream (a
  future label using the logo) gets only the approved id until a URL is added there.
- The tagline card reuses the name card's fields with the same hints, so pinned releases keep
  working; changing those hints on one card breaks them.
- Without Redis, the in-process bus reaches only workers in the same process; a dispatch made
  by another process (or lost by a restart mid-task) waits for the periodic recovery.
- No stale-`in_progress` threshold, max attempts or backoff yet; production scan interval and
  multi-instance ownership are open. RabbitMQ is the planned replacement for the Pub/Sub wake-up.
- The legacy wizard's other steps (label, web page, marketing) are not wired to agents. The
  landing page has a frozen v1 content contract (`src/landing-page/contract.ts`) with no producer
  ([`pipeline/decisions/KAN-76-landing-block-set.md`](../../pipeline/decisions/KAN-76-landing-block-set.md),
  proposed).

## See also

- [03-deliverable-lifecycle.md](03-deliverable-lifecycle.md) — the commands that create tasks
- [06-assets-storage.md](06-assets-storage.md) — where the image goes
- [09-ai-configuration.md](09-ai-configuration.md) — LLM and image providers
