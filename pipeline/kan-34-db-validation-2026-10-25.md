# KAN-34 approvals, staleness and refinement: DB validation (2026-10-25)

Branch `feat/kan-34-approvals` (base `developer` at `afd46de`). Persistence layer for KAN-34
(RF-06) per the approved decision KAN-65 (A + R2), consistent with the KAN-64 command table.
No LLM, fal, eval, `.env.local`, or shared/dev/Railway database was used.

## Change

- `1792800000000_deliverable-approvals`
  - `deliverables`: new UNIQUE `(tenant_id, id, conversation_id, kind)` so history rows can
    bind deliverable, conversation and kind with one composite FK. The existing
    `selected_at` + partial unique index `deliverables_selected_per_kind` stays the single
    source of "the approved one"; `superseded_by` now means "replaced as approved by".
  - `deliverable_approvals` (append-only trail): tenant, conversation, owner `user_id`,
    `deliverable_kind`, `deliverable_id`, `replaced_deliverable_id`, `approved_by`,
    `approved_at`, `event_seq`. Composite FKs to conversations `(tenant_id, id, user_id)` and
    deliverables `(tenant_id, id, conversation_id, kind)`, cascading.
  - `deliverable_stale_marks` (append-only staleness events): tenant, conversation, owner,
    `deliverable_kind`, `marked_by`, `marked_at`, `event_seq`. Stale = newest mark newer than
    newest approval of the kind, so a later approval clears it without deleting anything.
  - Shared sequence `deliverable_event_seq`; trigger `app.guard_deliverable_event()` assigns
    `event_seq` and the timestamp on INSERT (client values overwritten), rejects every UPDATE
    and any DELETE that is not an FK cascade.
  - FORCE RLS; SELECT policy tenant AND (tenant admin OR owner); INSERT policy tenant AND owner
    AND actor = current user AND active member. `app_user`: SELECT, INSERT, sequence USAGE.
- `1792800001000_iteration-refinement-check`: `app.is_valid_refinement(jsonb)` and CHECK
  `agent_tasks_refinement_valid` (refinement only on iteration rows, same caps as the repo).
- Repos: `approvalsRepo` (approve, getApproved, listHistory, markStale, listStale),
  `createPostgresApprovalStore` (structural `IApprovalStore`), `refinementsRepo.createIteration`,
  pure `refinement-rules.ts`. `repos(tenant, user)` exposes `approvals` and `refinements`.

Caps: observations ≤ 5, each 1–500 code points (trimmed, not only whitespace); parameter
changes ≤ 20, keys `^[A-Za-z][A-Za-z0-9_]{0,63}$`, values string ≤ 200 / number / boolean;
anchor null or a deliverable of the parent task. Per-type iteration caps stay with KAN-43.

## Disposable PostgreSQL runs

Each run used a fresh `postgres:16-alpine` container with a unique name, `--rm`, `--tmpfs`
data directory, a random `127.0.0.1` port, a random superuser password, and a random
`app_user` password set after migrations; database `creamype_ci`. Both containers were removed
at the end (verified with `docker ps -a`). No other container was touched.

| Step | Fresh install | Upgrade |
|---|---|---|
| Base | none | 19 `origin/developer` migrations from `git archive origin/developer migrations`, then a legacy conversation (non-empty `agent_states`), completed task and two deliverables |
| Apply branch migrations | 21 applied, last `1792800001000_iteration-refinement-check` | 2 applied (21 total) |
| `down 2` then `up` | tables, sequence, function, CHECK and new UNIQUE removed, then re-created; CHECK validated | same; legacy conversation, `agent_states`, task and both deliverables preserved, none selected |
| RLS / policies / grants | both tables `relrowsecurity` and `relforcerowsecurity`; `*_read` (SELECT), `*_insert` (INSERT); `app_user` INSERT, SELECT only | same |
| `node scripts/ci-db-check.mjs` | passed | passed |
| `approvals.integration.test.ts` | 10 passed | 10 passed |
| `ai-config.integration.test.ts` | 12 passed | 12 passed |
| `global-persistence.integration.test.ts` | 3 passed | 3 passed |
| `agent-tasks.integration.test.ts` | 7 passed | 7 passed |
| `cross-tenant-isolation.integration.test.ts` | 1 passed | 1 passed |
| Total | 5 files, 33 passed, 0 skipped | 5 files, 33 passed, 0 skipped |

The approvals suite covers: schema/RLS/grants; first approval, replacement (both history rows,
replaced id returned, exactly one selected row, `superseded_by` set, re-approval flips back);
stale expected ids (old id, null, random, malformed) and the idempotent re-approval (no new
row); concurrency with five approvals queued behind a held conversation lock (verified in
`pg_stat_activity`) → one winner, four `stale`, one history row, plus an unblocked parallel
replacement race; wrong conversation, wrong kind, unfinished task, unknown kind, unknown and
malformed ids, and another member of the same tenant (`not_found`); tenant B reads nothing and
cannot approve or mark; raw cross-tenant, cross-owner and forged-actor inserts fail RLS (42501);
tenant-admin context reads; UPDATE/DELETE denied to the member and the admin context (42501) and
rejected for the schema owner by the trigger; forged `event_seq`/`marked_at` overwritten;
deleting the conversation cascades; staleness mark, no regeneration, no-op re-approval keeps it,
replacement clears it, a newer mark re-marks, marks are never removed, unknown kind and other
member throw; refinement iteration (normalized observations, anchor, parameters, parent keys
copied, numbering 2 then 3, overrides not carried forward), cap violations rejected before any
write with the Spanish message, other member / other tenant / foreign anchor / unfinished parent
rejected, DB CHECK rejects an oversized refinement and a refinement on a root row (23514), and
`conversations.agent_states` is byte-for-byte unchanged; TS/SQL parity on 45 shared cases.

## Local checks

- `npx tsc --noEmit --incremental false`: passed.
- ESLint on all changed files: passed.
- `npx vitest run src/repos --exclude "**/*.integration.test.ts"`: 9 files, 86 tests passed
  (adds `approval-store.test.ts` 11 and `refinement-rules.test.ts` 54).

## Not verified / residual

- The core port `src/core/approvals.ts` is created by the KAN-28 branch; this branch declares an
  identical structural copy. The match is checked by TypeScript only once both branches meet.
- `approve` and `markDependentsStale` are separate port calls, so they commit in separate
  transactions. A crash between them leaves an approval without its dependent marks.
- Approving a candidate generated before an upstream change clears that kind's staleness
  (the rule is "a later approval clears it"). Whether KAN-35 should compare generation inputs is
  open.
- Stale marks are recorded even for kinds with no approval yet; the state function should only
  overlay `obsoleto` on `aprobado`.
