[← Features](README.md)

# Conversations: resume latest and «Mis conversaciones»

## What it does

Opening the app takes the owner back to their most recent conversation instead of starting
over. «Mis conversaciones», in the chat header next to **Nuevo**, lists the latest 20 by last
activity (labelled with the business name and date) and offers **Nueva conversación**. Starting
a new conversation keeps the old one. An id that is not yours shows «No encontramos esta
conversación.» with **Ir a mi última conversación**.

## How it works

1. **The single decision point.** `src/conversations/selection.ts` (server-only) decides which
   conversation a signed-in user sees. `app/page.tsx` (after the terms check,
   [08-consent.md](08-consent.md)) calls `resolveHomeConversation(conversationId)`:
   - no id → redirect to the most recent own pinned conversation by last activity (newest
     message, else start time); create and pin a new one only when there is none;
   - an id → open it only if it is the caller's own pinned conversation
     (`readPinnedConversation` in `src/repos/conversations.ts`); foreign, missing, malformed and
     legacy ids all return the same `not_found` result. Malformed ids are filtered by
     `isConversationId` and never reach SQL.
2. **List.** `listOwnedConversations` reads `conversations.listRecent` (`src/repos/conversations.ts`,
   a `LEFT JOIN LATERAL` on the existing messages index; no migration) and labels each entry
   server-side with `src/conversations/label.ts:conversationListLabel`
   («<business name> · <d mmm>» or «Nueva conversación · <d mmm>», es-PE, `America/Lima`).
3. **Menu.** `components/crea-mype/ConversationMenu.tsx` starts from the page's list and
   refreshes it from `app/actions/conversations.ts:listConversationsAction` each time it opens.
   Entries are plain links (`/?conversationId=…`), so the server re-checks ownership on every
   switch. «Nueva conversación» opens `components/crea-mype/RestartModal.tsx`.
4. **Create and load.** `createConversationAction` and `loadConversationAction` in
   `app/actions/conversations.ts` reuse `createOwnedConversation` / `loadOwnedConversation`. A new
   conversation pins the active AI release in the same transaction
   ([09-ai-configuration.md](09-ai-configuration.md)). `app/page.tsx` keys `CreaMype` by
   conversation id so a switch remounts it with fresh state. A loaded conversation carries its
   persisted brief (`history.brief`, built by `src/conversations/brief-panel.ts:briefPanelFields`
   from the snapshot `readPinnedConversation` already returns, the same projection the brief
   panel action uses), so `CreaMype` shows it on first paint instead of an empty panel. It also
   carries the deliverable states (`history.states`, KAN-30): `loadOwnedConversation` registers
   the owner with the core and reads `getDeliverableStates`, the same read-only derivation as the
   panel action, so a task in progress, a failure and the candidates show on first paint
   (`CreaMype` `initialStates`). If that read fails it logs and returns `[]`; the page still opens
   and the client reload fills the panel.
5. **Export.** `exportConversationTraceAction` downloads the conversation's full ordered trace
   (KAN-42, [15-trace-and-metrics.md](15-trace-and-metrics.md)). The owner gets it from
   «Exportar» in the chat header; an active tenant admin of the same tenant gets it from
   «Exportar conversación» in `/admin/ai`. Anyone else gets the not-found answer.

## Key rules / invariants

- **One place decides which conversation is shown.** Later state-recovery work builds on
  `selection.ts`, not on ad-hoc queries. Enforced by `src/conversations/__tests__/selection.test.ts`
  ("resumes the most recent own pinned conversation by last activity", "creates one" only when
  none is resumable).
- **Every non-owned id looks the same.** Foreign-user, foreign-tenant, missing, malformed and
  legacy ids get one identical not-found result, so ids cannot be probed. Enforced by
  `selection.test.ts` and the KAN-25 case in
  `src/core/__tests__/cross-tenant-isolation.integration.test.ts`.
- **Starting a new conversation never discards the old one.** Nothing is marked `abandoned`.
  Enforced by `selection.test.ts` ("starting a new conversation keeps the previous one listed")
  and `components/crea-mype/__tests__/ConversationMenu.test.tsx`.
- **A resumed conversation shows its brief, messages, tasks and deliverables.** They come back
  from the server render, not from a later client fetch, and the reload dispatches nothing.
  Enforced by `selection.test.ts` ("resumes a conversation with its persisted brief…", the two
  «KAN-30» cases), `app/actions/__tests__/conversations.test.ts` (no `executeCommand` or
  `applyDelta` on load) and `components/__tests__/CreaMype.test.tsx` («KAN-30» block).
- **Labels use Lima time and neutral Spanish.** Enforced by
  `src/conversations/__tests__/label.test.ts` and `ConversationMenu.test.tsx`.

## Decisions

- 2026-10-25 — KAN-25 (owner): resume by last activity; legacy unversioned conversations hidden;
  20 entries, no pagination, search or title column; one not-found message for every
  non-owned id; new conversations keep old ones.

## Limits & known gaps

- No pagination or search; only the latest 20 are listed.
- Legacy unversioned conversations cannot be opened from the page
  (`loadConversationAction` still returns their `legacy_unversioned` code).
- The list has no status filter.

## See also

- [01-chat-turn.md](01-chat-turn.md) — what happens inside a conversation
- [05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md) — ownership checks
- [08-consent.md](08-consent.md) — the check that runs before any conversation is selected
