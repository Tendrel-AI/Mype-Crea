# KAN-35 — Staleness of derived deliverables (RF-07)

Status: **approved by the owner on 2026-11-02** (recommendations accepted as drafted)

## Decision (2026-11-02)

1. **The dependency map is data**: the Agent Card field `mypes:deliverable.dependsOn`. No agent-
   or field-specific `if` in the core. New edges are card edits.
2. **Staleness triggers** for a generated deliverable:
   - (a) an upstream approval it was generated under is replaced by another approval (or no
     longer exists);
   - (b) a brief field it actually used changes value (or is no longer filled).
3. **Effect**: the deliverable shows «Potencialmente desactualizado» (overlay on «Aprobado» or
   «En revisión») with a notice in its panel card. Nothing is regenerated automatically: the
   owner decides with Generar or Iterar. An approved deliverable stays approved, flagged.
4. **History is never rewritten**: staleness is computed from append-only rows on every read.
5. Formulation/profile (nutrition, KAN-37) and the label (KAN-39) are not built. Their policy is
   recorded below as future edges, with no code.

## Dependency map

| Upstream | Dependent | Where | Status |
|---|---|---|---|
| `business_name` (verbal identity, name-agent) | `logo` | `agents/logo-agent/agent-card.json` `dependsOn: ["business_name"]` | **live** |
| `tagline` | `logo` | logo card `dependsOn`, when KAN-32 lands | future (card edit only) |
| brand (`business_name`, `logo`) | `label` | label card `dependsOn`, when KAN-39 builds the label agent | future edge |
| octagon determination | `label` (confirmation) | a KAN-37 kind in the label card `dependsOn` | future edge |
| formulation / nutrition profile (brief fields) | octagon determination, label confirmation | trigger (b): the profile fields the KAN-37 handler records as used | future policy |

A profile change invalidates the octagon determination and the label confirmation through the
same two triggers: the determination records the profile fields it used (b), and the label
records the determination approval it was built under (a) and the profile fields it prints (b).

## How it works

- **Brief fields (b).** The handler records the fields its prompt actually used in the artifact
  metadata: `inputs = { <field>: { value, version } }`, with `version = inputVersion(value)`
  (`sha256:<hex>`, `src/core/deliverable-inputs.ts`, shared by every agent). The logo records
  `business_name`, `style_keywords` and `color_palette` (only when filled); the name agent records
  its own inputs (KAN-31). The metadata is stored with the deliverable row
  (`deliverables.artifact_metadata`, KAN-81). A field the handler did not use never flags it.
- **Upstream approvals (a).** When a command creates a task, the core stores the approved
  deliverable id of every `dependsOn` kind in the task's `requirements_snapshot` under the
  reserved key `upstream_approvals`. Workers strip the key, so handlers never see it.
- **Derivation.** `deriveStaleCandidateIds` (`src/core/orchestrator/deliverable-state.ts`) is
  pure. A candidate is stale when a recorded field version differs from the current brief, or a
  recorded upstream id differs from the current approval of that kind. The card overlay is about
  the current candidate: the approved one, else the newest.
- **One hop per real change.** A flagged upstream does not flag its dependents: it is still
  approved, still unblocks them, and only when the owner replaces it does each dependent's
  recorded id differ. A dependent that uses an upstream directly declares a direct edge. This
  avoids a trap: editing the style (used by both name and logo) flags the name, but the logo can
  still be iterated without generating new names first.
- **Legacy rows.** Tasks created before KAN-35 have no `upstream_approvals`. For them the KAN-34
  stale marks still decide (approved deliverables only). The marks keep being written with every
  approval as an append-only record of the event.

Switching back to the original name (or value) clears the flag, because the references are
stable. A new Iterar or Generar under the new inputs produces a fresh candidate; the old one stays
stale in history.

## Not done here

- No new planner decision and no Responder prompt change: the notice lives in the
  server-derived card view, which survives a reload.
- The approved name is not written into the brief's `business_name`; the logo prompt still reads
  the brief field. Both triggers cover a change to either.

## Sources

Jira KAN-35 (AC 1–4 and DoD), [KAN-64](KAN-64-dispatch-model.md) («obsoleto» overlay row),
[KAN-65](KAN-65-selection-approval-refinement.md) (approval replacement marks dependents),
thesis P0370 (dependents keep a stable reference; changes notify instead of regenerating).
