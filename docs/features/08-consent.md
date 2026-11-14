[← Features](README.md)

# Consent: the terms gate (`terminos-v1`)

## What it does

Before the wizard appears, a signed-in user sees the terms (what is collected, why, who
processes it, Ley N.º 29733, contact). The button stays disabled until the box is checked;
accepting is an explicit act recorded with the database clock. No chat turn or deliverable
command runs for a user who has not accepted the current version, and a new version asks again.

## How it works

1. **One text, one version.** `src/consent/terms.ts:CURRENT_TERMS` holds the full text and its
   version (`CURRENT_TERMS_VERSION`, today `terminos-v1`). Any wording change ships with a new
   version, which makes every user accept again. The rejection messages
   (`TERMS_REQUIRED_MESSAGE`, `TERMS_UNAVAILABLE_MESSAGE`) live there too.
2. **Show it first.** `app/page.tsx` calls `src/consent/gate.ts:currentTermsStatus` before
   selecting or creating any conversation and renders
   `components/crea-mype/TermsConsent.tsx` instead of the wizard until the user has accepted.
3. **Accept.** The form calls `app/actions/terms.ts:acceptTermsAction`. The server accepts only
   a literal `accepted: true` for the current version and takes tenant and user only from the
   session (`resolveIdentity`).
4. **Evidence.** `repos(tenant, user).termsAcceptances` (`src/repos/terms-acceptances.ts`:
   `hasAccepted`, `accept`) writes `terms_acceptances` (migration
   `migrations/1792800005000_terms-acceptances.js`): one row per tenant, user and version;
   `accepted_at` set by the database; re-accepting is a no-op.
5. **Server-side gate.** `src/consent/gate.ts:checkCurrentTerms` (fail closed) runs in
   `app/actions/chat.ts:chatAction` and
   `app/actions/deliverable-command.ts:deliverableCommandAction` right after identity, before any
   conversation, turn, LLM or agent work. Codes: `terms_required`, or `terms_unavailable` when the
   check itself fails.
6. **Not gated** (they send nothing to an LLM or agent): conversation create/list/load/export,
   `loadDeliverableStatesAction`, the SSE stream and the asset route. The logo worker only runs
   tasks created by a gated command.

## Key rules / invariants

- **No AI work without acceptance of the current version, checked on the server.** Hiding the
  wizard is not enough: a direct call is rejected too. Enforced by
  `app/actions/__tests__/chat.test.ts` and `app/actions/__tests__/deliverable-command.test.ts`
  (never accepted, older version only, check fails → closed).
- **Acceptance is explicit and bound to the session identity.** Enforced by
  `app/actions/__tests__/terms.test.ts`.
- **The evidence is append-only, owner-scoped and server-timestamped.** `app_user` may only
  SELECT and INSERT three columns; `id` and `accepted_at` come from the database; RLS shows a
  user their own rows (tenant admins may read). Enforced by the KAN-27 case in
  `src/core/__tests__/cross-tenant-isolation.integration.test.ts`.
- **The terms text uses neutral Spanish with tuteo and states every owner-required point.**
  Enforced by `components/crea-mype/__tests__/TermsConsent.test.tsx`.

## Decisions

- 2026-11-02 — KAN-27 (SYS-02) merged as `terminos-v1`; owner approval of the text is required
  before any wording change is merged. Catalog, processors and mechanism:
  [`docs/personal-data.md`](../personal-data.md).
- Regulatory context: [`pipeline/regulatory/README.md`](../../pipeline/regulatory/README.md)
  (KAN-50 rules draft, KAN-54 legal review packet; not a legal approval).

## Limits & known gaps

- Open owner decisions ("Por definir" in `docs/personal-data.md`): retention per data category
  (today: keep everything), how to withdraw consent, legal response deadlines, a direct contact
  address, and whether to name the data controller and processors.
- There is no withdrawal flow in the app.
- Whether message content ever reaches application logs was not audited in KAN-27.

## See also

- [01-chat-turn.md](01-chat-turn.md) — the first gated entry point
- [03-deliverable-lifecycle.md](03-deliverable-lifecycle.md) — the second gated entry point
- [05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md) — RLS behind the evidence table
