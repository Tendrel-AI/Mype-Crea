[← Features](README.md)

# Live updates: SSE stream, notifiers, "processing" events

## What it does

After the owner taps Generar, the card switches to «Generando» when the worker picks the task
up, and the finished logo (or a failure) appears without reloading. If the tab was closed, a
reload restores everything from the database.

## How it works

1. **Open the stream.** `components/CreaMype.tsx` opens an `EventSource` on
   `GET /api/agents/stream?conversationId=…` (`app/api/agents/stream/route.ts:GET`) and listens
   for every kind in `CLIENT_NOTIFICATION_KINDS`. A new conversation closes the old stream and
   opens a fresh one.
2. **Authorize.** The route rejects a non-UUID id (400), resolves identity (401 without a
   session), and opens only the caller's own **pinned** conversation
   (`readPinnedConversation` in `src/repos/conversations.ts`; 404 otherwise, 409 for a legacy
   unversioned one). It never creates a conversation.
3. **Ephemeral events.** It subscribes to `defaultLifecycleNotifier.subscribeProcessing`
   (`src/core/orchestrator/notifiers.ts`) and forwards `task_processing`, which the worker
   publishes right after claiming a task. These are not stored: missing one only delays the
   «Generando» label.
4. **Durable events.** Every second it polls the per-conversation outbox
   (`peekEvents` in `src/repos/ai-turns.ts`), parses each row through the contract, writes it to
   the response as `task_completed` or `task_failed`, and only then acknowledges it (`ackEvent`).
   The worker wrote these rows in the same transaction as the deliverable
   (`settleTaskAndEnqueue`, [02-agents-and-transport.md](02-agents-and-transport.md)).
5. **Keep-alive and re-checks.** A heartbeat every 15 s keeps proxies from closing the
   connection; organization status and membership are re-checked every 30 s
   (`verifyActiveMembership` in `src/auth/resolve-identity.ts`), and the stream closes if access
   is revoked.
6. **One contract.** Every notification (decision, artifact, processing, completed, failed,
   dispatch) is defined once in `src/core/contracts/notifications.ts`: versioned
   (`NOTIFICATION_CONTRACT_VERSION`), a zod schema per kind, `serializeNotification` /
   `parseNotification` (never throws), Redis channel names (`redisChannelFor`), outbox kinds
   (`DURABLE_NOTIFICATION_KINDS`), and the client projection `toClientNotification`.
7. **Notifiers.** `src/core/orchestrator/notification-channels.ts` has a Redis channel
   (`RedisNotificationChannel`) and an in-process one (`InProcessNotificationChannel`). The
   decision, artifact and lifecycle notifiers (`redis-decision-notifier.ts`,
   `redis-artifact-notifier.ts`, `redis-agent-lifecycle-notifier.ts` and their in-process
   siblings in `src/core/orchestrator/`) are thin wrappers over them. Redis is used when
   `REDIS_URL` is set; Postgres `LISTEN/NOTIFY` is not an option behind transaction-pooling
   PgBouncer.
8. **Failure detail.** The route reads `src/services/failure-disclosure.ts:exposesTaskFailureDetail`
   once per connection. Off (default), a `task_failed` frame carries no technical detail and the
   card shows the plain Spanish message; on (`DEVELOPMENT=TRUE`), the chat also shows a
   «[Modo desarrollo] …» notice (`components/crea-mype/failure-copy.ts:developerFailureChatText`).

## Key rules / invariants

- **The database outbox, not Redis, owns the result.** Redis only wakes things up; the outbox
  row commits with the deliverable, and reload restores state, so a lost Pub/Sub message loses
  nothing. Enforced by `app/api/agents/stream/__tests__/route.test.ts` ("acks a durable event
  only after writing it to the stream").
- **A reconciled completion places the logo live, like the live one.** `CreaMype` reads the logo
  URL with `components/crea-mype/live-logo.ts:completedLogoUrl` (an `image` artifact from
  `logo-agent`). Enforced by `components/crea-mype/__tests__/live-logo.test.tsx` (rebuilt notice
  from the real repository code → parser → panel) and `src/repos/__tests__/ai-turns.test.ts`.
- **A row that does not match the contract is logged, acknowledged and skipped.** One bad row
  cannot block the outbox. Enforced by `route.test.ts` ("acks and skips a durable row that does
  not match the contract…") and `src/core/__tests__/notifications.test.ts` (rejections never
  throw).
- **Technical failure detail is developer-only, behind one gate.** Changing the policy is a
  one-line change in `failure-disclosure.ts`; the planner never sees it. Enforced by
  `notifications.test.ts` ("failure detail is developer-only") and `route.test.ts`
  ("forwards the technical detail when DEVELOPMENT=TRUE").
- **A stream never outlives the caller's access.** Enforced by `route.test.ts` ("closes an open
  stream… when membership is revoked") and `src/auth/__tests__/resolve-identity.test.ts`.
- **Failure messages are sanitized before storage.** `sanitizeFailureMessage` removes secrets,
  URL queries and control characters and caps the length. Enforced by `notifications.test.ts`.

## Decisions

- 2026-10-25 — KAN-58: one notification contract for every producer and consumer; failure detail
  only in developer mode; no `announce_failure` decision.
- 2026-10-25 — KAN-81: a rebuilt completion notice must equal the live one (artifact kind and
  metadata are stored on the deliverable).

## Limits & known gaps

- Acknowledgement means "written to the server response", not "received by the browser"; the
  reload path covers the gap.
- The Responder text is not streamed over SSE; it returns from the chat action.
- Without Redis, the workers run over an in-process bus and write the same durable notice
  (KAN-82); the ephemeral `task_processing` event then reaches only SSE streams in the same
  process.

## See also

- [02-agents-and-transport.md](02-agents-and-transport.md) — who writes the outbox
- [03-deliverable-lifecycle.md](03-deliverable-lifecycle.md) — how the card reacts
- [05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md) — the identity checks
