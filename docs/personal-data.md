# Personal data and informed consent (KAN-27, SYS-02)

This document lists the personal data CreaMype actually collects or processes, why each item is
needed, and how informed consent is recorded and enforced. It describes the code on `developer`.
Items marked **Por definir** are open owner decisions; do not treat them as settled.

## 1. Informed consent

- **Terms text**: one versioned constant, `CURRENT_TERMS` in `src/consent/terms.ts`
  (current version `terminos-v1`). Any wording change ships with a new `version`, which makes
  every user accept again. Owner approval of the text is required before merge.
- **When it is shown**: `/` (`app/page.tsx`) checks the signed-in user's acceptance of the
  current version before selecting or creating any conversation, and renders
  `components/crea-mype/TermsConsent.tsx` instead of the wizard until it exists.
- **Explicit act**: the checkbox only enables the button. Acceptance is the server action
  `acceptTermsAction({ termsVersion, accepted: true })` (`app/actions/terms.ts`). The server
  rejects anything but literal `accepted: true`, rejects any version other than the current one,
  and takes tenant and user only from the session.
- **Evidence**: table `terms_acceptances` (migration `1792800005000_terms-acceptances`): tenant,
  user, terms version, `accepted_at` set by the database clock. Append-only (no UPDATE/DELETE
  grant), one row per (tenant, user, version), RLS tenant + owner (tenant admins may read).
- **Server-side gate** (`checkCurrentTerms` in `src/consent/gate.ts`, fail closed): rejects the
  request with no conversation, turn, LLM or agent work unless the caller accepted the current
  version. Gated entry points:
  - `chatAction` (`app/actions/chat.ts`): every chat turn (Extractor and Responder LLM calls).
    Code `terms_required` (or `terms_unavailable` when the check itself fails).
  - `deliverableCommandAction` (`app/actions/deliverable-command.ts`): Generar / Iterar /
    Reintentar / Aprobar / Cancelar, which dispatch agents with the user's brief.
  Not gated because they send nothing to an LLM or agent: conversation create/list/load/export,
  `loadDeliverableStatesAction`, the SSE stream, the asset route. The logo worker only runs tasks
  created by a gated command.

## 2. Catalog of personal data

| Data | Where it is stored | Why it is needed |
|---|---|---|
| WorkOS user id, email | `users` (Postgres) | Identify the signed-in user and bind every row to them (RLS). Name is read from the WorkOS session for the greeting and is not stored locally |
| Organization membership and role | `users.tenant_id`, `users.role`, `users.status` | Tenant isolation and authorization (member vs. tenant admin) |
| Chat messages (user and assistant) | `messages`, `ai_turns.input_content` / `response_content` | Hold the conversation and recover an interrupted turn without repeating it |
| Business and product brief, from the chat or edited in the brief panel (business name, category, style, colors, product, composition, presentation, manufacturer) | `conversations.agent_states` | The requirements each agent needs to produce a deliverable; only fields declared in the agent cards are stored, each with the channel that wrote it (`source`) |
| Provider requests and responses per turn | `ai_turn_attempts.request_content` / `response_content` | Recovery and audit of uncertain provider outcomes; tenant admins can scrub this content (`app.scrub_ai_turn_trace`) |
| LLM usage metadata (model, tokens, latency) | `llm_calls`, `ai_turn_attempts` | Cost and audit; no message content |
| Brief copy per generation, iteration observations | `agent_tasks.requirements_snapshot` | What the agent was asked to produce, for replay and iteration |
| Generated deliverables (logo images) | private storage bucket (`deliverables.storage_key`) and `deliverables` | The deliverable itself, served only to its owner |
| Approvals and staleness marks | `deliverable_approvals`, `deliverable_stale_marks` | Who approved which deliverable and when |
| Terms acceptance | `terms_acceptances` | Evidence of informed consent per terms version |
| Refused write attempts (KAN-44): actor, channel, conversation id, field name, reason, and a SHA-256 hash of the refused value (never the value itself) | `write_rejections` | Security audit of attempts to write fields outside the catalog; read by the actor and tenant admins |
| Identifiers in logs (tenant, user, conversation ids) | application logs | Operations and debugging; message content is not meant to be logged (not audited in KAN-27) |

Not collected by design: national ID (DNI), address, phone, payment data, health data. The terms
ask users not to type them into the chat.

## 3. Processors that receive data

| Processor | What it receives | Why |
|---|---|---|
| OpenRouter or Anthropic (per pinned AI release) | Extractor: the user message and the pending confirmation. Responder: the last 10 messages, the current brief and the planner decisions | Interpret the message and write the reply |
| fal.ai | The image prompt built from the brief (and iteration observations) | Generate the logo |
| WorkOS | Sign-in identity, email, organization membership | Authentication |
| Railway (Postgres, Redis, storage bucket) | Everything stored above; Redis carries transient task triggers | Hosting |
| LangSmith | Nothing in production (tracing is dev only and ignored when `NODE_ENV=production`; evals use synthetic data) | — |

## 4. Por definir (owner decisions)

- Retention periods for each category above (today: keep everything).
- Procedure and channel to withdraw consent, and what happens to existing data afterwards.
- Legal deadlines for answering data-subject requests under Ley N.º 29733 and its regulation.
- A direct contact address for data requests (the text currently points to the organization's
  administrator).
- Whether the terms should name the data controller and the processors (and any cross-border
  transfer, since the providers above operate outside Peru).
- Whether the terms should list login and hosting providers next to the AI and image providers
  (the draft mentions them generically).
