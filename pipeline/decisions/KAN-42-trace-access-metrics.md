# KAN-42 — Trace access, reconstruction, sampling and pilot metrics

Status: **approved 2026-11-02** (owner approved the recommendations as drafted; do not re-decide).

Jira KAN-42 ([SYS-07] Persistir la traza de conversación, generaciones e invocaciones).

## Decisions

1. **Who sees what.**
   - The conversation owner and their tenant admin can reconstruct the full trace of a
     conversation in their tenant, content included, under RLS. This follows the existing
     member/admin read precedent (`ai_config_audit_events`, `write_rejections`): the admin's
     persisted, active role is re-checked in the same transaction.
   - Platform operators get only metadata and aggregates: counts, latencies, costs, versions,
     statuses. Never message text or brief values.
2. **Reconstruction.** One read-only function assembles an ordered timeline per conversation
   from the existing tables: turns, attempts and LLM calls with model and prompt versions, the
   field deltas with their source, decisions, commands (tasks keyed by command id, approvals),
   tasks, deliverables with their input fingerprints, approvals, usage reservations and
   rejections. It is exposed as a JSON download for the owner and the admin by reusing the
   existing export («Descargar la conversación y sus registros»). An integration test on a
   seeded session asserts 100 % of the seeded events are present and ordered, in under 5 s.
3. **Monthly random sample.** A script in `scripts/` picks N random conversation ids per tenant
   for a month and writes their timelines to a local file. The operator runs it; it is not
   scheduled. Nothing new is stored.
4. **Metrics.** A report computes, for a date range within operating hours (weekdays
   09:00–18:00 America/Lima): interaction p95 (turn latency from existing timestamps), latency
   per deliverable (task created → settled) and mean cost per deliverable set (from
   `usage_reservations`). Own availability is computed from existing data only if possible;
   otherwise it is a documented gap with the way to measure it (external monitor on
   `/api/health`), never an invented figure.
5. **Cost reference.** USD 0.48 per set is the thesis estimate, shown as a reporting reference
   and marked **not approved as a cap**. The report never claims compliance.
6. **Migration.** Add one (prefix `1792800011000`) only if a correlation column or index is
   truly needed.

## How it was implemented

- Migration `1792800011000_conversation-trace` adds four functions and no table, column or
  index. Platform operators have no read path to tenant tables, so their metadata view, the
  sample and the metric samples need `SECURITY DEFINER` functions, like the existing
  `app.platform_monthly_metrics`. The existing indexes were enough for a sub-second timeline.
- Timeline: `app.conversation_trace_events` (one definition, `meta` and `content` per event),
  read by `repos(t, u, actor).trace.timeline` and exported by `exportConversationTraceAction`.
- Operators: `globalRepos().trace` and `scripts/trace-report.ts` (`sample`, `metrics`).
- Input fingerprint: SHA-256 of the task's `requirements_snapshot`, computed on read.
- A "set" is a conversation with at least one completed deliverable. Its cost is every
  non-denied reservation of the conversation (settled amount, else the estimate).
- Own availability: not computable (no uptime record). Documented gap in
  `docs/operations.md` section 11.

Details: [`docs/features/15-trace-and-metrics.md`](../../docs/features/15-trace-and-metrics.md),
[`docs/operations.md`](../../docs/operations.md) section 11.

## Open

- Own availability needs an external uptime monitor; nobody has set one up.
- No pilot measurement has been taken yet. Compliance with p95 < 4 s, availability ≥ 99 % or any
  cost figure must not be claimed until the pilot runs under the agreed hours and load.
