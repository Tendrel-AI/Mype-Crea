[← Features](README.md)

# Product brief and editable panel

## What it does

The owner builds the brand brief two ways: by chatting or by editing the brief panel. Both channels write the same fields through one server-validated operation. The panel shows each accepted value, its origin («Del chat» or «Editado aquí»), and values still «Por confirmar». It also lists what each deliverable is missing before «Generar» can run.

## How it works

1. **Catalog.** `src/core/brief.ts:BRIEF_CATALOG` holds 8 fields: business_name, business_category, style_keywords, color_palette, product_name, product_composition, product_presentation and manufacturer. Each has a Spanish label and a maximum length. `validateBriefValue` applies NFC, refuses control characters other than tab and newlines (KAN-44), collapses whitespace and enforces 1..maxLength. The catalog covers brand and product only; nutrition belongs to KAN-37.
2. **Panel write.** `app/actions/brief.ts:updateBriefFieldAction` authorizes through `app/actions/conversation-access.ts:authorizeConversation` (identity, ownership, terms). It then builds a `FieldDelta` (source `brief-panel`, confidence 1.0) and runs it through `applyDelta`, the same merge and planner path chat uses ([01-chat-turn.md](01-chat-turn.md)).
3. **Provenance.** Merge stores `FieldSlot.source` in the `agent_states` JSONB, so the origin survives a reload. `briefFromSnapshot` builds the panel view.
4. **Ambiguous values.** A low-confidence chat value stays pending until the user confirms it. A delta carries `expectedPendingValue`; when a late «sí» or «no» answers a question the panel has since overwritten, merge returns `stale_confirmation` and leaves the panel value in place.
5. **Preconditions.** The panel's missing-field list comes from the server's verdict. `deliverableCommandAction` checks the same preconditions again before generating.
6. **Pinned releases.** `src/adapters/chat-input-adapter.ts:frozenFieldsInRegistry` accepts a pinned AI release when its frozen fields are a subset of the registry. Conversations pinned before the brief keep extracting only the logo fields. Prompt version: `extractor.v5`.

## Key rules / invariants

- **One write path.** The panel never writes slots directly. Merge and planner stay pure and never branch on `FieldDelta.source`.
- **The server decides readiness.** Enforced by `app/actions/__tests__/brief.test.ts`, `src/core/__tests__/brief.test.ts`, `components/crea-mype/__tests__/BriefPanel.test.tsx` and `DeliverableCommands.test.tsx`.

## Decisions

- Chat plus an editable panel; brand and product fields, no nutrition (owner, 2026-11-02).

## Limits

- A chat restatement does not replace a value the user edited in the panel. The exception is an explicit correction while answering a confirm question. Logged as a known bug; the policy is the owner's call.
- The panel cannot clear a field.
- To extract the product fields from chat, someone must publish an AI release with the v5 field list ([09-ai-configuration.md](09-ai-configuration.md)).
- `extractor.v5` has had no real eval yet.
- A card field outside the catalog is checked only as plain text of at most 500 characters (`fieldRule`, KAN-44). Refused panel writes are logged in `write_rejections` ([05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md#write-catalog-and-rejection-log-kan-44)).

## See also

[01-chat-turn.md](01-chat-turn.md) · [03-deliverable-lifecycle.md](03-deliverable-lifecycle.md) · [08-consent.md](08-consent.md)
