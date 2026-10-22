# KAN-65 — Selection, approval, and refinement channels

Status: proposed — awaiting owner approval

## Context

- **Blocks:** KAN-34 (RF-06). KAN-34 then blocks KAN-35 (RF-07 staleness) and KAN-31. This
  resolves the `docs/agents/architecture.md` §2.7 **TBD with user**: the iteration UX and how
  `request_selection` / `selected_at` / `superseded_by` are used. It must match the command
  table in [KAN-64](KAN-64-dispatch-model.md).
- **Code today:** `agent_tasks` already chains iterations (`parent_task_id`,
  `iteration_root_id`, `iteration_number`, `iteration_trigger`). `insertIteration`
  (`src/repos/agent-tasks.ts:194`) is never called. `deliverables` has `selected_at` and
  `superseded_by`, with a partial unique index that allows one selected deliverable per
  `(conversation_id, kind)` (`migrations/1777047788085_deliverables.js:35-39`). Nothing sets
  either column. `select_deliverable` is a no-op. `RefinementSpec` (`src/core/contracts/deltas.ts`)
  has `parameterChanges` for v1 side-panel controls and a `freeTextHint` "reserved for v2".
  The `RequestSelectionDecision` decision kind exists but is never emitted.
- **Thesis:** RF-02 (T003R06, P0295): candidates are presented and "la selección final la realiza
  el usuario". RF-06 (T007R06, P0355): convergence to "un único aprobado por tipo; las
  iteraciones intermedias no coexisten como resultado final. La aprobación es un acto explícito".
  E5 (T020R07/P0691): refinement uses "observaciones ancladas a la iteración y por panel".
  Contingency P0777: refinement may be reduced to anchored observations "sin cambios de blueprint
  durante el refinamiento". RF-07 (P0370): dependents keep a stable reference, and changes notify
  instead of regenerating.
- **Conflict to resolve:** the contract comment makes free text a v2 channel, while the thesis
  puts anchored observations in Phase 1.

## Decision needed

1. Are selection and approval one act or two?
2. Can an approved deliverable be replaced? What happens to history and dependents?
3. Which refinement channels exist in Phase 1: panel parameters, anchored observations, free chat?
4. Does refinement modify the brief?

## Options

**A. One act: "Aprobar" is the selection.** Candidates and iterations stay proposals. Aprobar
sets `selected_at` on exactly one deliverable per type (existing index). Approving another
candidate atomically clears the old approval, stamps the new one, records an approval event,
and marks dependents stale (RF-07). Downstream agents consume only approved inputs. This is the
smallest change and reuses the schema. Its states are a pure function of rows, which suits the
planner claim. Risk: the thesis wording ("selección" in RF-02, "aprobación" in RF-06) could read
as two acts, so the record has to say they are merged.

**B. Two acts: select (working choice) then approve (final).** This adds `approved_at` with a
second partial unique index. A selected name could feed a tagline draft before approval. It is
more faithful to the literal wording, but adds states (selected-not-approved, approved,
replaced-while-dependent-in-flight), RF-07 rules for provisional inputs, and a migration. The
planner state space roughly doubles. Size: medium–large.

**C. One act with locking.** Same as A, but an approved deliverable cannot be replaced without an
explicit "Reabrir" (unapprove) command first. This is safer against accidental taps, but adds
one more command and one more state, and gains little because replacement already requires
explicit confirmation.

Refinement channel sub-options (independent of A/B/C):

- **R1 Panel only:** `RefinementSpec.parameterChanges` from structured controls (matches code
  comment).
- **R2 Panel + anchored observation:** a short free-text note attached to a specific candidate
  (`parentTaskId`), stored with the iteration, and passed only to that agent's handler as
  generation input. It is never parsed by the Extractor into facts or intents (matches
  P0691/P0777).
- **R3 R2 + free chat refinement:** "hazlo más azul" in the main chat becomes an iteration. This
  breaks the facts/intents separation (§2.3, §6), because the LLM would be producing commands.
  Not recommended.

## Recommendation

**A + R2.** Aprobar is the single explicit act that both selects and approves. Replacement is
allowed through another explicit Aprobar, with a confirmation dialog when dependents exist, and
it marks them stale (no automatic regeneration). Every approval and replacement is
appended to an approval history so reload shows the approved item and the full trail (KAN-34
AC4, RNF-04). Refinement uses the panel plus anchored observations, with a length cap and storage
in the iteration's `requirements_snapshot`. **Refinement never writes the brief.** Panel
parameter overrides are iteration-local. To change the brief, the user uses RF-01 (chat/panel),
which triggers RF-07 staleness. Free chat text that asks for a change is answered by the
Responder with guidance, for example: «Para ajustar este logo, toca el botón Iterar y escribe
qué quieres cambiar.» Concurrency: Aprobar carries the expected current approved ID (or none), and
a mismatch is rejected (KAN-34 AC3).

## Consequences / follow-up tickets

- Update the `RefinementSpec` comment and contract: anchored observation becomes a v1 field
  (rename `freeTextHint` → `observation`, bounded). Define `approve_deliverable` (replaces the
  no-op `select_deliverable`). Decide whether `RequestSelectionDecision` is removed or reused as
  "en revisión" prompting.
- Migration: an append-only approval-event table (tenant-scoped, RLS, composite FKs). The
  `superseded_by` meaning is fixed to "replaced as approved by".
- KAN-35 consumes approval events for staleness. Handlers must treat observations as untrusted
  input (prompt-injection suite, RNF-07). The copy must be neutral Spanish with tú.

## Open questions for the owner

1. Do you accept merging selection and approval into one "Aprobar" act (Option A)?
2. Phase 1 refinement: panel plus anchored observations (R2), or panel only (R1, the P0777
   contingency)?
3. Should panel parameter changes stay iteration-local (recommended), or offer «guardar en el
   brief»?
4. Should there be a maximum number of iterations per type in Phase 1, or should that wait for
   KAN-43 limits?
