# Pending pilot decisions

Draft decision proposals for the open `requiere-decision` Jira items. Each file states the
context (thesis anchors, Jira AC, current code), options, a recommendation, and short questions
for the owner. A decision is settled only when the owner approves it. The file's status line and the Jira issue are then updated. Items that need legal,
regulatory, or institutional input say so explicitly.

| Decision | Unblocks | Status | Recommendation (one line) |
|---|---|---|---|
| [KAN-43 — Usage limits before calling models](KAN-43-usage-limits-policy.md) | KAN-43 (SYS-08) | **approved 2026-11-02** | USD 30/month per tenant, 60 LLM calls/hour and 15 images/day per user, 4,000-character messages. Reserve under a lock before every provider call, then reconcile with the real cost. |
| [KAN-64 — Dispatch model and Phase 1 transitions](KAN-64-dispatch-model.md) | KAN-28 (SYS-03) | **approved 2026-10-25** | Replace auto-dispatch with typed, server-revalidated commands (Generar/Iterar/Aprobar/Reintentar/Cancelar) over a pure per-deliverable state function. "Avanzar" is navigation only. |
| [KAN-65 — Selection, approval, refinement channels](KAN-65-selection-approval-refinement.md) | KAN-34 (RF-06) | **approved 2026-10-25** | One explicit "Aprobar" act per type (replaceable, with history and RF-07 staleness). Refinement uses panel parameters plus anchored observations and never writes the brief. |
| [KAN-66 — Account operations and roles](KAN-66-account-operations-roles.md) | KAN-41 (SYS-06) | proposed — awaiting owner approval | Tenant admin can provision, list, deactivate, and reactivate members with tenant-scoped audit. Admin grants stay with platform operators. 1:1 WorkOS org ↔ tenant. |
| [KAN-67 — RPO, RTO, backup scope](KAN-67-rpo-rto-backup-scope.md) | KAN-53 | **approved 2026-11-02** (retention open) | Managed backups plus independent encrypted dumps kept in Railway's region (and pre-migration dumps). RPO ≤ 24 h, RTO ≤ 2 h, weekdays 09:00–18:00 America/Lima. The owner authorizes and executes restores. Assets covered only after KAN-52. Retention and post-pilot deletion need legal input. |
| [KAN-68 — Regulatory gate policy](KAN-68-regulatory-gate-policy.md) | KAN-59 (→ KAN-14) | **approved 2026-11-02** | The deterministic golden set blocks on PR, nightly, and release (P0436). P0773's non-blocking trend applies only to LLM/heavy suites. CI green ≠ legal approval (KAN-54). |
| [KAN-76 — Landing page block set](KAN-76-landing-block-set.md) | KAN-76 | proposed — awaiting owner approval | Freeze the implemented v1 contract with no producer in Phase 1 (thesis P0612 excludes web builders). Future v2 references approved deliverables by ID with a constrained theme. |

Dependencies between drafts: KAN-65 must stay consistent with the KAN-64 command table, and both
feed KAN-35 (staleness) and KAN-59 (planner/state tests). KAN-67 depends on KAN-52 for asset
coverage. KAN-68's "blocking" is policy, not GitHub-enforced: the private Free-plan repository
cannot set required checks, so the owner does not merge to `main` while the regulatory job is red.

Sources: Jira KAN-14/18/19–22/26/28/31/34/35/41/48/50/51/53/54/59/63–68/76 (read-only);
thesis `LopezMatias.docx` anchors (P-paragraphs and T-table rows); `pipeline/kan-61/62/63`;
`docs/ui/landing-page-content-contract.md`; local `docs/agents/*`; and the code paths cited in each
file.
