[← Features](README.md)

# Deliverable lifecycle: commands, approval, refinement, staleness, failures

## What it does

Each deliverable card in the panel shows a state («Bloqueado», «Listo para generar»,
«Generando», «En revisión», «Aprobado», «Falló», plus an «Obsoleto» overlay) and only the
buttons that make sense now: **Generar**, **Iterar** (with a short note on what to change),
**Aprobar**, **Reintentar**, **Cancelar**. A failure is never a dead end: the card explains it in
plain Spanish and offers at least one way out.

## How it works

1. **Read the state.** `app/actions/deliverable-command.ts:loadDeliverableStatesAction` returns,
   per deliverable, a `DeliverableStateView` (`src/core/contracts/deliverables.ts`) computed by
   the pure `src/core/orchestrator/deliverable-state.ts:deriveDeliverableState` from facts: the
   brief, tasks, candidates, approvals and stale marks. Precedence: `generating` > `failed` >
   `approved` > `in_review` > `enabled` > `blocked`. The view lists `allowedCommands` and a
   `stateToken` (a deterministic hash of the facts).
2. **Render.** `components/crea-mype/DeliverableCommands.tsx:DeliverableCommands` draws buttons
   from `allowedCommands` (advisory only). Failure copy comes from
   `components/crea-mype/failure-copy.ts:failedCardMessage`. «Avanzar» is UI navigation, not a
   command.
3. **Send a command.** `app/actions/deliverable-command.ts:deliverableCommandAction`
   authenticates, checks the terms gate, authorizes the owner's pinned conversation, checks the
   shape (an exact key set: a forged actor or a smuggled brief field is refused), and calls `OrchestratorCoreImpl.executeCommand`
   (`src/core/orchestrator/orchestrator-core.ts`), which adds a per-conversation lock and an
   in-memory replay cache. Every refused command, whether its shape, a foreign conversation or a
   core rejection, is logged in `write_rejections`
   ([05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md#write-catalog-and-rejection-log-kan-44)).
4. **Re-validate on the server.** `src/core/orchestrator/deliverable-commands.ts:executeDeliverableCommand`
   checks, in order: shape → durable replay (the command id is the task `idempotency_key`; a
   reused id with a different agent, kind or conversation is refused with
   `COMMAND_MESSAGES.replayConflict`, KAN-44) →
   unknown agent → already-applied replays → `expectedState`/`stateToken` mismatch (`stale`) →
   not in the fresh `allowedCommands` (`not_allowed`) → command-specific checks. Rejections carry
   a neutral-Spanish message (`COMMAND_MESSAGES`) and the fresh states.
5. **Apply.**
   - **Generar** → a root task, inserted under SQL guards (`insertCommandTask` in
     `src/repos/agent-tasks.ts`: advisory lock per conversation, one active task per
     conversation and agent, unique idempotency key), then dispatched.
   - **Iterar** → an iteration chained to the anchor candidate (given id, else approved, else
     newest), trigger `user_regenerate`, with a refinement (panel parameter changes plus one
     observation ≤ 500 code points) stored in the task's `requirements_snapshot`. Rules live in
     `src/core/refinement.ts` (`validateRefinement`, `buildIterationRefinement`); iteration rows
     go through `src/repos/refinements.ts`. Refinement never writes the brief.
   - **Reintentar** → an iteration chained to the failed task, trigger `failure`, no refinement.
   - **Aprobar** → one call to `IApprovalStore.approve` (`src/core/approvals.ts`; Postgres impl
     `src/repos/approval-store.ts:createPostgresApprovalStore`) that records the approval and
     marks every transitive dependent stale (`dependentKindsOf`) in one transaction.
   - **Cancelar** → `pending → canceled` only; a result that arrives later never overwrites it.
6. **Staleness.** «Obsoleto» shows on an approved deliverable only when an explicit stale mark
   (`deliverable_stale_marks`) is newer than its newest approval
   (`src/core/orchestrator/deliverable-state.ts:deriveStaleKinds`). Nothing is regenerated
   automatically; the user may Generar again.
7. **Failures.** The worker or transport reports a typed `error.kind`;
   `src/core/task-errors.ts:classifyTaskError` maps it to `transient | content_policy |
   permanent_bug` (unknown → `permanent_bug`). `FAILURE_RECOVERY_COMMANDS` in
   `deliverable-state.ts` gives Reintentar for every category, plus Iterar for
   `content_policy`. Technical detail reaches the chat only in developer mode
   ([04-live-updates.md](04-live-updates.md)).

## Key rules / invariants

- **Only a typed panel command changes a deliverable; chat text never does.** No paid generation
  can be triggered by prompt injection. Enforced by
  `src/core/orchestrator/__tests__/deliverable-commands.test.ts` ("no dispatch without a
  command") and `src/core/orchestrator/__tests__/planner.test.ts` (offer never dispatches).
- **The server re-derives the state for every command; the buttons are only advisory.** A stale
  tab gets `stale`, not a wrong action. Enforced by
  `src/core/orchestrator/__tests__/deliverable-commands.test.ts` and
  `src/core/orchestrator/__tests__/deliverable-state.test.ts` (KAN-64 table, determinism and the
  state token).
- **One refinement rule in TypeScript and SQL.** `src/core/refinement.ts` is the single
  definition; the database CHECK `app.is_valid_refinement` (migration
  `migrations/1792800001000_iteration-refinement-check.js`) mirrors it. Enforced by the shared
  parity cases `src/repos/__tests__/fixtures/refinement-parity-cases.ts`, used by
  `src/repos/__tests__/refinement-rules.test.ts`.
- **Approval is atomic, append-only and owner-only.** Approval plus stale marks commit or roll
  back together; history rows cannot be updated or deleted; a tenant admin can read but not
  approve (trigger in `migrations/1792800002400_approval-owner-only.js`). Enforced by
  `src/repos/__tests__/approval-store.test.ts` and `src/repos/__tests__/approvals.integration.test.ts`
  (real DB, run only with approval).
- **A failure always offers a recovery button when the brief allows it.** Enforced by
  `src/core/__tests__/task-errors.test.ts`, `deliverable-state.test.ts` and
  `components/crea-mype/__tests__/DeliverableCommands.test.tsx`.

## Decisions

- 2026-10-25 — KAN-64: typed, server-revalidated commands over a pure state function; auto-dispatch
  removed. [`pipeline/decisions/KAN-64-dispatch-model.md`](../../pipeline/decisions/KAN-64-dispatch-model.md)
- 2026-10-25 — KAN-65: one explicit «Aprobar» per type (replaceable, with history and staleness);
  refinement = panel parameters + anchored observation, never writes the brief.
  [`pipeline/decisions/KAN-65-selection-approval-refinement.md`](../../pipeline/decisions/KAN-65-selection-approval-refinement.md)
- 2026-10-25 — KAN-34: «Obsoleto» comes only from explicit stale marks, never from comparing
  approval timestamps; only the conversation owner approves.
- 2026-10-25 — KAN-58: a failure is never a dead end (Reintentar always; Iterar for content
  policy); no `announce_failure` planner decision.

## Limits & known gaps

- A durable replay compares the agent, the kind and the conversation, but not an Iterar's
  observation or parameters. The in-process cache compares the whole command.
- Retry and iteration have no per-deliverable cap; only the KAN-43 image and budget limits bound them ([13-usage-limits.md](13-usage-limits.md)).
- Staleness does not yet compare the inputs each candidate was generated from with current
  approvals (future KAN-35 work).
- `dependsOn` is empty on every card, so «Bloqueado» by an upstream approval does not occur in
  practice with only the logo live.
- A Reintentar after a failed Iterar drops that refinement (owner decision, kept).

## See also

- [02-agents-and-transport.md](02-agents-and-transport.md) — how a task is executed
- [04-live-updates.md](04-live-updates.md) — how the card learns the result
- [06-assets-storage.md](06-assets-storage.md) — how candidates are shown
