[← Features](README.md)

# Chat turn: Extractor → Merge → Planner → Responder

## What it does

The owner writes in Spanish ("Mi negocio se llama Dulce Valle y quiero algo minimalista"). The
app pulls the facts out of the message, asks to confirm anything it is unsure about, asks for at
most two missing items at a time, and, once the brief is complete, invites the owner to tap
**Generar**. The reply is neutral Latin-American Spanish with tuteo.

## How it works

1. **Controller.** `app/actions/chat.ts:chatAction` validates the request id and message, calls
   `src/auth/resolve-identity.ts:resolveIdentity`, then the terms gate
   `src/consent/gate.ts:checkCurrentTerms` ([08-consent.md](08-consent.md)). It loads the
   owner's pinned conversation (`ensurePinnedConversation` in `src/repos/conversations.ts`) and
   claims the turn by `requestId` (`claimTurn` in `src/repos/ai-turns.ts`), so a retried request
   returns the stored result instead of running twice.
2. **Extractor (LLM).** `src/adapters/chat-input-adapter.ts:ChatInputAdapter` asks the model for
   the deduplicated union of every registered Agent Card's fields and returns a `FieldDelta`
   (`src/core/contracts/deltas.ts:FieldDelta`): values with a confidence, grouped by agent. A bare
   "sí"/"no" after a confirmation question skips the LLM
   (`src/adapters/chat-input-adapter.ts:classifyConfirmationReply`); a compound reply ("sí, y mis
   colores son…") is extracted and combined with the yes/no. The model call runs through the
   conversation's pinned AI release (`AiConfigRuntime.runPurpose`, see
   [09-ai-configuration.md](09-ai-configuration.md)). The turn is checkpointed as `extracted`.
3. **Merge (pure rules).** `src/core/orchestrator/merge.ts:mergeFieldDelta` applies
   `src/core/contracts/deltas.ts:CONFIDENCE_THRESHOLDS`: ≥ 0.9 → slot `filled`, ≥ 0.6 →
   `pending_confirmation`, lower → dropped (the planner will ask again). Order inside one delta:
   `reset_field` intents, then values, then other intents. Unknown agents or fields are rejected
   with no write. It writes through the injected `IConversationStore` port
   (`src/core/orchestrator/in-memory-store.ts` in tests,
   `src/core/orchestrator/postgres-store.ts:PostgresConversationStore` in production, which keeps
   the slots in `conversations.agent_states`).
4. **Snapshot.** The state the planner reads is
   `src/core/contracts/conversation.ts:ConversationSnapshot`: per agent, required and optional
   `FieldSlot`s (`empty | pending_confirmation | filled`), `iterationCount` and
   `lastDispatchedTaskId`.
5. **Planner (pure).** `src/core/orchestrator/planner.ts:planNextDecision` returns
   `PlannerDecision[]` (`src/core/contracts/decisions.ts:PlannerDecision`). First match wins:
   a pending slot → `confirm_field` (alone); else the lexically first agent with missing required
   fields → `request_fields` with up to `MAX_FIELD_BATCH_SIZE` (2) fields; else an agent whose
   deliverable state is `enabled` and never dispatched → `offer_generation`; else
   `announce_all_complete`. Ties break lexically by agent id, then field name.
6. **Core wiring.** `src/core/orchestrator/orchestrator-core.ts:OrchestratorCoreImpl` runs
   `applyDelta` (merge only, never dispatches) and `peekNextDecision`, which reads the deliverable
   states (I/O through ports), passes them to the pure planner as data, and puts any queued
   `announce_dispatch` / `announce_completion` in front. The controller checkpoints
   `effects_started` / `effects_committed` and then calls `acknowledgeDecisions`, so each
   announcement reaches exactly one turn.
7. **Responder (LLM).** `src/adapters/chat-output-adapter.ts:ChatOutputAdapter` turns the
   decisions plus the last 10 messages into Spanish prose. Text only: no tools, no names, no
   images. `offer_generation` is rendered as "tap Generar", never as "I started it". The prompt
   versions (`extractor.v4`, `responder.chat-step1.v6`) and frozen prompt fragments live in
   `src/services/ai-config/adapter-behavior.ts`.
8. **Commit.** `completeTurn` stores the reply; the browser (`components/CreaMype.tsx`,
   `components/crea-mype/ChatPanel.tsx`) shows it.

## Key rules / invariants

- **The planner is pure and deterministic: same snapshot and states, same plan.** This is the
  thesis claim; it is why the planner has no LLM, no I/O and no branching on
  `FieldDelta.source`. Enforced by the table-driven, LLM-free
  `src/core/orchestrator/__tests__/planner.test.ts` (including "same snapshot and states produce
  the same plan").
- **Merge decides only by confidence and order, never by who produced the delta.** Keeps chat,
  forms or voice interchangeable. Enforced by `src/core/orchestrator/__tests__/merge.test.ts`
  (reset + value ordering, unknown-field rejection).
- **The core is agent-agnostic: no agent- or field-specific `if`s in `orchestrator-core.ts`.**
  New agents must work by adding a card. Enforced by the fixture-agent smoke test
  `src/core/__tests__/orchestrator-smoke.test.ts` ("orchestrator smoke (agent-agnostic)").
- **Facts and commands are separate; the Extractor never produces intents.** Intents come from
  state (a reply to `confirm_field`) or typed UI commands. This is the prompt-injection defense:
  chat text can fill a slot but cannot start, approve or cancel anything. Enforced by
  `src/adapters/__tests__/chat-input-adapter.test.ts` and, for generation,
  `src/core/orchestrator/__tests__/deliverable-commands.test.ts` ("no dispatch without a command").
- **A chat turn is idempotent per request id and never repeats paid work.** A duplicate returns
  the stored reply; a committed turn resumes at the Responder. Enforced by
  `app/actions/__tests__/chat.test.ts`.
- **Every user-facing reply uses neutral Spanish with tuteo, never voseo.** The prompts state
  the rule explicitly; the eval check `responder.no_voseo` in `evals/evaluators/responder.ts`
  scores real outputs (paid, run only with the owner's OK).

## Decisions

- 2026-10-25 — KAN-64: auto-dispatch removed; the planner only *offers* generation.
  [`pipeline/decisions/KAN-64-dispatch-model.md`](../../pipeline/decisions/KAN-64-dispatch-model.md)
- 2026-10-21 — KAN-56: the confirm fast path applies only to a bare yes/no; compound replies are
  extracted.
- 2026-10-21 — KAN-55: announcements are read without consuming them and acknowledged after the
  turn is checkpointed.
- 2026-10-04 — LangGraph was evaluated and not adopted for the decision layer: if it is added
  later it may only wrap the turn, `src/core` keeps zero framework imports, and the planner is
  never encoded as graph edges. Today no LangGraph package is installed. (Recorded in the
  maintainers' local architecture guide, which is not tracked in git.)

## Limits & known gaps

- Only wizard step 1 (brief + logo) runs through this pipeline; the other wizard steps are not
  wired.
- `FieldDelta` intents `select_deliverable`, `request_iteration` and `cancel_task` are accepted
  but do nothing; the real commands are the typed panel buttons
  ([03-deliverable-lifecycle.md](03-deliverable-lifecycle.md)).
- The reply is returned whole from the server action, not streamed token by token.
- The real Responder eval for prompt v6 has not been run (needs the owner's OK).

## See also

- [02-agents-and-transport.md](02-agents-and-transport.md) — where the fields come from (Agent Cards)
- [04-live-updates.md](04-live-updates.md) — what arrives after the turn
- [09-ai-configuration.md](09-ai-configuration.md) — how the model is chosen and logged
