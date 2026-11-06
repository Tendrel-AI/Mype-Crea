# KAN-64 — Dispatch model and Phase 1 transitions

Status: **approved by the owner on 2026-10-25** (recommendation accepted as drafted)

## Decision (2026-10-25)

The owner approved the recommendation: **Option B**. This answers the open questions below as follows:

1. Auto-dispatch is removed for every deliverable, **including the live logo flow**. Generation
   starts only from an explicit typed command (Generar, Iterar, Aprobar, Reintentar, Cancelar),
   re-validated server-side against the pure per-deliverable state function in the table below.
2. "Avanzar" is UI navigation only. It is not a server transition in Phase 1.
3. Per-type caps on user retries are deferred to KAN-43 (usage limits).
4. Option C (a chat «sí» confirms an offered generation) is deferred until there is pilot feedback.

KAN-28 (SYS-03) is unblocked.


## Context

- **Blocks:** KAN-28 (SYS-03, explicit commands and flow state). KAN-28 in turn blocks KAN-31
  (name agent), KAN-34 (RF-06), and KAN-44. Iteration/approval semantics are decided in
  [KAN-65](KAN-65-selection-approval-refinement.md); this record must stay consistent with it.
- **Code today: auto-dispatch.** After every merge, `OrchestratorCoreImpl` calls
  `findAgentReadyToDispatch` (`src/core/orchestrator/planner.ts:206`, called from
  `orchestrator-core.ts:230`). The first agent (lexical order) whose required fields are all
  `filled`, that is not in flight and has `iterationCount === 0`, is dispatched with no user
  action. Re-runs never auto-dispatch (§2.7). Typed intents exist (`select_deliverable`,
  `request_iteration`, `cancel_task`, `reset_field` in `src/core/contracts/deltas.ts:98`),
  but merge handles only `reset_field`. There is no "generate" intent. Only `logo-agent` is
  registered. Failures are always persisted as `transient`
  (`orchestrator-core.ts:564`; known bug `2026-10-04-failed-tasks-always-transient`).
- **Thesis requires explicit commands.** P0271 ("el sistema no despacha tareas por decisión
  propia"), P0456 ("el modelo propone, el usuario dispone, el servidor valida"), P0574, P0627
  (commands: solicitar generación, iterar, aprobar, avanzar), P0644 (per-type states
  *bloqueado, habilitado, generando, en revisión*; buttons Generar/Iterar/Aprobar enabled by the
  server state machine), T019R04, T020R03. RNF-07's metric (P0428) is explicit: no malicious
  input may "desencadenar la producción de un entregable sin acción explícita del usuario". With
  auto-dispatch, a chat message that makes the Extractor fill the last required field starts a
  paid generation, so that metric cannot pass.
- **Jira constraints:** KAN-28 AC: the extractor alone must not generate. Stale commands are
  rejected. The planner and merge stay pure. Agents are reached only through `IAgentTransport`.
  Retries and stages must not be decided by inference.

## Decision needed

1. Explicit commands or auto-dispatch for Phase 1?
2. The command set, per-deliverable states, preconditions, and stale-command handling.
3. Retry scope. What does "Avanzar" mean?

## Options

**A. Keep auto-dispatch and document the deviation.** No code change. This breaks P0271, P0456
and the RNF-07 metric. The deterministic-planner claim survives only weakly: the decision is
deterministic, but untrusted chat text indirectly triggers paid side effects. Size: none.
Risk: the thesis defense has to explain away a stated requirement.

**B. Explicit typed commands with a pure availability function (state machine).**
A new pure function, for example `deriveDeliverableStates(snapshot, deliverables, dependencyMap)`,
computes each agent's state. The UI renders buttons from it. A command (`request_generation`,
`request_iteration`, `approve_deliverable`, `retry_task`, `cancel_task`) carries an expected
state token. Under the existing conversation row lock, the server recomputes the same function and
creates the `agent_tasks` row only if the transition is legal and the token matches. Otherwise it
rejects the command as stale or not allowed. `findAgentReadyToDispatch` stops dispatching and
becomes the "habilitado" predicate. The planner emits a new `offer_generation` decision so the
Responder can tell the user, for example: «Ya tienes todo listo para tu logo. Cuando quieras,
toca el botón Generar.» This strengthens the claim: same snapshot gives the same states and plan, and
side effects come only from typed commands (§6). Size: medium. It needs a contract change to
intents and decisions, state derivation with table tests, server actions, buttons, and Responder
prompt bump. Risk: more taps on mobile, and a contract change needs design review (§3).

**C. B plus chat confirmation of an offered generation.** As in B, but when the last plan was
`offer_generation`, a «sí» reply goes through the existing state-derived confirmation fast path
and becomes `request_generation`. Intents still come only from state or typed UI, never from the
Extractor LLM. This is friendlier for chat-only users. Risk: RNF-07 reviewers may not count a
typed «sí» as an explicit action. It also adds a fast-path edge case, such as «sí, pero en azul».
Size: B + small.

## Recommendation

**Option B** for Phase 1. C can be added later if pilot users struggle with buttons. B satisfies
P0271/P0456/P0428 literally, and it makes the state machine a second pure, table-testable
artifact that supports the thesis claim. Proposed transition table (per deliverable type):

| State | Meaning (derived, pure) | Allowed commands → next state |
|---|---|---|
| bloqueado | required brief fields not `filled`, upstream deliverable not approved, or regulatory exposure gated (KAN-54) | none |
| habilitado | preconditions met, no active task, no candidate yet | Generar → generando |
| generando | task `pending`/`in_progress` | Cancelar (only while `pending`) → previous state |
| en revisión | ≥1 candidate, none approved | Iterar → generando; Aprobar(candidate) → aprobado |
| aprobado | exactly one approved (KAN-65) | Iterar → generando; Aprobar(other candidate) → aprobado (replace) |
| fallido | last task failed | Reintentar → generando, only if `transient`; otherwise a visible error message |
| obsoleto (overlay) | approved but an upstream input changed (RF-07, KAN-35) | Iterar/Generar; never automatic regeneration (P0370) |

Rules: every command re-validates preconditions server-side at task creation (P0285, P0456).
UI button state is advisory (P0644). Stale tokens are rejected with neutral Spanish copy. User
retries create a new iteration with `iteration_trigger = 'failure'`. Transport-level replay
stays under KAN-63. "Avanzar" is **not** a server transition in Phase 1. Unlocking follows
upstream approval through a declarative dependency map (data, not `if`s in the core), and
"Avanzar" is UI navigation only.

## Consequences / follow-up tickets

- Contract change: add `request_generation`, rename/define `approve_deliverable`, add
  `retry_task`, and add an `offer_generation` decision. Update `data-structures.md` and §2.3.
- The dependency map is declared as data, for example a new Agent Card field `mypes:dependsOn`.
  It is shared with KAN-35.
- Fix the error classifier (known bug) before "Reintentar only if transient" can work.
- Update planner/state tests (KAN-59 AC1), the RNF-07 injection suite, Responder prompt version, and
  the Figma states in KAN-51.

## Open questions for the owner

1. Approve Option B, which removes auto-dispatch, including for the live logo flow?
2. Is "Avanzar" only UI navigation, or do you want an explicit stage-advance command recorded in
   the server state?
3. Should user retries have a per-type cap now, or wait for the KAN-43 usage limits?
4. Defer Option C (chat «sí» confirms an offered generation) until pilot feedback?
