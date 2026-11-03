[← Features](README.md)

# Deliverable lifecycle: commands, approval, refinement, staleness, failures

## What it does

Each deliverable card in the panel shows a state («Bloqueado», «Listo para generar»,
«Generando», «En revisión», «Aprobado», «Falló», plus a «Potencialmente desactualizado» overlay)
and only the
buttons that make sense now: **Generar**, **Iterar** (with a short note on what to change),
**Aprobar**, **Reintentar**, **Cancelar**. A failure is never a dead end: the card explains it in
plain Spanish and offers at least one way out.

Each candidate in the card (KAN-29) also says which iteration of its type it is and whether it
is ready or approved («Iteración 2 · Lista», «Iteración 1 · Aprobada»), carries its own
«Potencialmente desactualizado» flag, and has a «Detalles» disclosure with its type, generation
time, model, prompt and agent versions, the brief data it used and, for a derived deliverable,
the approved upstream it was built on. The card names the iteration in progress or the one that
failed. This is the same panel, not a second gallery.

## How it works

1. **Read the state.** `app/actions/deliverable-command.ts:loadDeliverableStatesAction` returns,
   per deliverable, a `DeliverableStateView` (`src/core/contracts/deliverables.ts`) computed by
   the pure `src/core/orchestrator/deliverable-state.ts:deriveDeliverableState` from facts: the
   brief, tasks (with their recorded upstream approvals), candidates (with their recorded input
   versions), approvals and legacy stale marks. Precedence: `generating` > `failed` >
   `approved` > `in_review` > `enabled` > `blocked`. The view lists `allowedCommands` and a
   `stateToken` (a deterministic hash of the facts).
2. **Render.** `components/crea-mype/DeliverableCommands.tsx:DeliverableCommands` draws buttons
   from `allowedCommands` (advisory only). Failure copy comes from
   `components/crea-mype/failure-copy.ts:failedCardMessage`. «Avanzar» is UI navigation, not a
   command. Image candidates render as a grid of thumbnails; text candidates (the names of
   KAN-31, `textCandidate`) render as a list of name plus one-line reason, followed by the note
   «Verifica la disponibilidad del nombre en INDECOPI antes de usarlo.»
   (`NAME_AVAILABILITY_NOTE`). **Per-candidate view (KAN-29):** each `DeliverableCandidateView`
   carries `iteration` (1-based ordinal of its task among the type's non-canceled tasks),
   `stale` (in `deriveStaleCandidateIds`) and `provenance`, built by the pure
   `deliverable-state.ts:candidateProvenance` from the artifact metadata and the task's
   `upstream_approvals`: only `promptVersion`, `agentCardVersion`, `provider`, `model`, the
   string `metadata.inputs` values and the approved upstream (id and text value) are copied; the
   logo's raw prompt never reaches the client. `activeTask` and `lastFailure` carry
   `iteration` too. `DeliverableCommands` renders it with `candidateStatusLine`,
   `provenanceRows` and `formatGeneratedAt` (`es-PE`, `America/Lima`); rows that recorded
   nothing say «No registrado». The logo handler records `LOGO_PROMPT_VERSION` and its
   agent card version; name and tagline already did. The «Nombre comercial» card and, under it, the «Lema» card
   (KAN-32 taglines, same text list) sit in step 1 of the dashboard and in the mobile panel
   (`components/CreaMype.tsx:renderNameCommands`). A card blocked by an unapproved upstream names
   it (`missingUpstreamMessage`: «Primero aprueba tu nombre comercial.»).
3. **Send a command.** `app/actions/deliverable-command.ts:deliverableCommandAction`
   authenticates, checks the terms gate, authorizes the owner's pinned conversation, checks the
   shape (an exact key set: a forged actor or a smuggled brief field is refused), runs the KAN-43
   usage preflight for Generar/Iterar/Reintentar (kind `llm` for `name-agent` and `tagline-agent`,
   `image` otherwise), and calls `OrchestratorCoreImpl.executeCommand`
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
     appends a stale mark for every transitive dependent (`dependentKindsOf`) in one transaction.
   - Every task-creating command also stores the approved id of each `dependsOn` kind in the
     task's `requirements_snapshot.upstream_approvals` (workers strip it before the handler),
     and, when that approved candidate is text, its id and value in
     `requirements_snapshot.upstream_inputs` (KAN-32), which reaches the handler as
     `A2AMessage.upstream` (the tagline reads the approved name from it).
   - **Cancelar** → `pending → canceled` only; a result that arrives later never overwrites it.
6. **Staleness (RF-07, KAN-35).** «Potencialmente desactualizado» shows on an approved or
   in-review deliverable when its current candidate (approved, else newest) was generated from
   inputs that changed since (`deriveStaleCandidateIds`): a brief field the handler recorded as
   used in `metadata.inputs` (`sha256:` version from `src/core/deliverable-inputs.ts:inputVersion`)
   has another value, or an upstream approval recorded on its task was replaced (one hop per real
   change; a flagged approval stays approved and keeps unblocking its dependents). The dependency map is `mypes:deliverable.dependsOn` (today `business_name` → `logo` and `business_name` → `tagline`).
   The card shows the notice from `components/crea-mype/DeliverableCommands.tsx:staleNotice` and
   offers Generar and Iterar; nothing is regenerated automatically and an approved deliverable
   stays approved. Tasks created before KAN-35 fall back to the KAN-34 stale marks
   (`deriveStaleKinds`, approved only). Policy and future edges (label, nutrition):
   [`KAN-35-staleness-policy.md`](../../pipeline/decisions/KAN-35-staleness-policy.md).
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
- **A name is chosen with the same «Aprobar», and the copy never promises it is free to use.**
  Five candidates per run; the name card needs `business_category` and `style_keywords`
  (`product_name` optional). No copy, prompt or hint claims availability or uniqueness; the
  INDECOPI note is shown instead. Enforced by `app/actions/__tests__/name-agent-flow.test.ts`
  (Generar → five candidates → Aprobar, replaced with history; refused without the rubro, nothing
  dispatched), `agents/name-agent/__tests__/handler.test.ts` and
  `components/crea-mype/__tests__/DeliverableCommands.test.tsx`.
- **A tagline needs an approved name and is chosen with the same «Aprobar».** Five candidates
  per run, each with its reason and the approved name's id and fingerprint in
  `metadata.inputs.business_name`; without an approved name the card is «Bloqueado» and a forged
  Generar is refused (`not_allowed`). Approving another name flags it without regenerating.
  Enforced by `app/actions/__tests__/tagline-agent-flow.test.ts`,
  `agents/tagline-agent/__tests__/handler.test.ts`, the `upstream_inputs` case of
  `src/core/__tests__/deliverable-commands.postgres.integration.test.ts` and
  `src/workers/__tests__/logo-agent-worker.test.ts` (tagline worker).
- **The deliverables view shows each deliverable's iteration, state and provenance, and only the
  owner's (KAN-29).** It reads through the same owner-scoped path
  (`loadDeliverableStatesAction` → `authorizeConversation` → `repos(tenant, user)`); a foreign or
  unknown conversation reads nothing. Provenance is copied key by key, never the raw prompt.
  Enforced by `src/core/orchestrator/__tests__/deliverable-state.test.ts` («KAN-29» block),
  `components/crea-mype/__tests__/DeliverableCommands.test.tsx` («KAN-29» block),
  `app/actions/__tests__/name-agent-flow.test.ts` and `tagline-agent-flow.test.ts` (provenance
  end to end, including the approved name used) and `app/actions/__tests__/deliverable-command.test.ts`
  («never returns another user's deliverables»).
- **Staleness is computed, never stored, and never regenerates.** History rows are not
  rewritten; a reload re-derives the same flag; unrelated deliverables are untouched; going back
  to the original name or value clears it. Enforced by `deliverable-state.test.ts` («KAN-35»
  block), `app/actions/__tests__/name-agent-flow.test.ts` (name → logo end to end, reload with a
  fresh core) and `src/core/__tests__/deliverable-commands.postgres.integration.test.ts`
  (recorded `upstream_approvals` over Postgres; run only with approval).
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
- 2026-11-02 — KAN-35: the dependency map is `dependsOn` data; a replaced upstream approval or a
  changed brief field the deliverable used marks it «Potencialmente desactualizado», computed
  from recorded inputs; never regenerated automatically. Supersedes the KAN-34 «marks only» rule
  for new tasks. [`pipeline/decisions/KAN-35-staleness-policy.md`](../../pipeline/decisions/KAN-35-staleness-policy.md)
- 2026-11-03 — KAN-29: the deliverables query lives in the existing cards (no second gallery, no
  filters, pagination or extra history). «En proceso / listo / falló / aprobado» reuse the KAN-64
  card labels plus «Lista»/«Aprobada» per candidate. The regulatory view (label text, composed
  label, warnings, «verificar con DIGESA») and rule/standard versions are deferred to KAN-39/KAN-40,
  which build on this view.
- 2026-10-25 — KAN-58: a failure is never a dead end (Reintentar always; Iterar for content
  policy); no `announce_failure` planner decision.

## Limits & known gaps

- A durable replay compares the agent, the kind and the conversation, but not an Iterar's
  observation or parameters. The in-process cache compares the whole command.
- Retry and iteration have no per-deliverable cap; only the KAN-43 image and budget limits bound them ([13-usage-limits.md](13-usage-limits.md)).
- The logo needs an approved name («Bloqueado» with «Primero aprueba tu nombre comercial.» until
  then), but an approved name is not written back to the brief's `business_name`: the logo
  prompt still reads the brief field. Both changes flag the logo. The tagline reads the approved
  name itself, so editing the brief's `business_name` does not flag it.
- The staleness notice is in the card only; the chat Responder does not mention it (no planner
  decision for it).
- Logos generated before KAN-35 record no inputs, so a brief edit does not flag them; their
  upstream staleness falls back to the KAN-34 marks.
- A Reintentar after a failed Iterar drops that refinement (owner decision, kept).
- Iteration numbers count failed attempts, so the candidates may read «Iteración 1» and
  «Iteración 3» when the second attempt failed. Logos generated before KAN-29 show «No
  registrada» for their versions.
- Text candidates of one run (five names or taglines) repeat the same «Detalles».

## See also

- [02-agents-and-transport.md](02-agents-and-transport.md) — how a task is executed
- [04-live-updates.md](04-live-updates.md) — how the card learns the result
- [06-assets-storage.md](06-assets-storage.md) — how candidates are shown
