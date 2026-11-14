[← Features](README.md)

# Trace and pilot metrics

## What it does

Every conversation can be rebuilt as one ordered timeline: what the owner wrote, what each model
extracted and from where, what the planner decided, which models, prompts and releases ran, which
tasks and deliverables followed, what was approved, what was refused, and what each call cost.
The owner and their tenant admin can download it with its content. Platform operators see only
metadata (counts, latencies, costs, versions, statuses), take a random monthly sample, and get a
pilot metrics report. Nothing new is stored: the timeline is read from rows the app already
writes.

## How it works

1. **One definition.** The SQL function `app.conversation_trace_events(tenant, conversation)`
   (migration `migrations/1792800011000_conversation-trace.js`) joins the existing tables into
   events ordered by time. Each event has a `meta` half and a `content` half:

   | Event | Source | `meta` (also visible to operators) | `content` (owner and admin only) |
   |---|---|---|---|
   | `conversation` | `conversations`, `ai_releases` | status, pinned release id and content hash, brief provenance (agent, field, status, source) | user id, current brief values |
   | `terms_acceptance` | `terms_acceptances` | terms version | — |
   | `turn` | `ai_turns` | request id, stage, duration, delta source, extracted field names and confidence, intent and decision kinds | input, response, checkpoint payload (delta, decisions, snapshot) |
   | `message` | `messages` | role, status, turn id | text |
   | `attempt` | `ai_turn_attempts` | purpose, profiles, provider, model, revision, status, tokens, latency, cost, pricing version | provider request and response |
   | `llm_call` | `llm_calls` | provider, purpose, model, revision, prompt version, tokens, latency | — |
   | `notice` | `ai_turn_notices` | code | text |
   | `write_rejection` | `write_rejections` | channel, agent, field, reason | user id, payload hash |
   | `usage_reservation` | `usage_reservations` | kind, status, denial reason, estimate, actual cost, turn/attempt/task ids | user id |
   | `task` / `task_settled` | `agent_tasks` | agent, card version, command id, iteration, status, error category, duration, input fingerprint | requirements snapshot, error |
   | `deliverable` | `deliverables` | kind, task, input fingerprint, stored, selected/superseded | asset route, inline value |
   | `outbox_event` | `ai_turn_events` | event id and kind, task, acknowledged at | payload |
   | `approval` / `stale_mark` | `deliverable_approvals`, `deliverable_stale_marks` | kind, deliverable ids, event sequence | approver |

   The input fingerprint is the SHA-256 of the task's `requirements_snapshot`, so a deliverable
   points to the exact brief it was made from. LLM calls and usage rows correlate through the
   conversation id or the task id.
2. **Owner and tenant admin.** `repos(t, u, actor).trace.timeline(conversationId)`
   (`src/repos/conversation-trace.ts`) runs the function in a READ ONLY transaction as `app_user`.
   The owner reads under the ordinary RLS. For an admin, the repository re-checks the persisted
   active admin role (`app.has_tenant_admin()`) and only then sets `app.is_tenant_admin` for that
   transaction. Every branch joins the conversation the caller can see, so tenant-wide tables
   never leak another member's rows. `exportConversationTraceAction` returns it as JSON:
   «Exportar» in the chat header, and «Exportar conversación» in `/admin/ai` for the selected
   turn. Stored images appear as `/api/assets/<id>`, never the provider URL or the bucket key.
3. **Platform operators.** `globalRepos().trace` (`src/repos/platform-trace.ts`) re-checks the
   persisted superadmin role and calls three `SECURITY DEFINER` functions:
   `app.platform_conversation_trace` (the `meta` half only),
   `app.platform_trace_sample` (N random conversations per tenant in a month) and
   `app.platform_pilot_metric_samples` (latencies and per-set costs as numbers).
4. **Operator script.** `scripts/trace-report.ts`, run by hand with `npx vite-node`:
   `sample` writes the metadata-only timelines of the monthly sample to a local file; `metrics`
   prints the report computed by `src/services/trace/pilot-metrics.ts`. See
   [`docs/operations.md`](../operations.md) section 12.

## Key rules / invariants

- **Owner and same-tenant admin only; everyone else gets "not found".** Another member (even one
  who claims admin in the actor), another tenant, and a direct SQL call all get nothing.
  Enforced by `src/repos/__tests__/conversation-trace.integration.test.ts`.
- **Complete and ordered in under 5 s.** The same integration test seeds a session with turns,
  a generated and approved logo, a refused write and usage reservations, and asserts every
  seeded event in the exact order, in under 5 s, for the owner and the admin.
- **Operators never see content.** The test asserts that no message text, brief value, prompt,
  notice, provider URL, payload hash or user id appears in the platform view.
- **The report never claims compliance.** It shows values next to their references. Enforced by
  `src/services/trace/__tests__/pilot-metrics.test.ts`.

## Decisions

[`pipeline/decisions/KAN-42-trace-access-metrics.md`](../../pipeline/decisions/KAN-42-trace-access-metrics.md)
(owner, 2026-11-02).

## Limits

- **Own availability is not measured.** No uptime record exists. It needs an external monitor
  polling `GET /api/health`, separate from third-party status.
- The brief provenance in the `conversation` event is the current state. Earlier panel edits are
  not versioned; chat changes are visible through each turn's delta.
- An admin's trace read is logged (`trace.tenant_admin_read`) but not written to an audit table.
- Turn latency is server-side (`ai_turns.created_at` → `completed_at`). It leaves out the network,
  the preflight before the turn row, and rendering.
- Trace content scrubbed through `/admin/ai` («Eliminar contenido») stays scrubbed in the timeline.

## See also

[01-chat-turn.md](01-chat-turn.md) · [03-deliverable-lifecycle.md](03-deliverable-lifecycle.md) ·
[09-ai-configuration.md](09-ai-configuration.md) · [10-admin-platform.md](10-admin-platform.md) ·
[13-usage-limits.md](13-usage-limits.md)
