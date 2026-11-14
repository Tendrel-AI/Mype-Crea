# KAN-70 persistence contract (v1)

This file defines database-backed persistence seams for release management, immutable local
conversation pins, and recoverable durable turns. All calls run through `repos(tenant, user)` and
`withTenantTransaction`; there is no tenantless application repository. The identity supplied
to the factory comes from `requireTenantAdmin()` or `requirePlatformAdmin()` in
`src/auth/resolve-identity.ts`, never from request JSON.

## Release catalog and tenant snapshots

`ai_shared_releases` is a separate global platform catalog with platform-only writes. It has no
`tenant_id`; this is the deliberate shared-catalog exception and is never referenced directly by
tenant activations or conversation pins. Shared drafts carry exact JSON-pointer
`allowed_override_paths`. `ai_releases` always has a non-null `tenant_id`. It holds tenant drafts,
permitted tenant overrides, and immutable snapshots copied from shared releases.
Both frozen tables store the validated manifest as JSONB, its canonical JSON string, and SHA-256
hash. A database trigger verifies that the canonical text parses to the stored JSON and hashes to
the stored value when freezing; once frozen, the manifest/canonical text/hash are immutable.
Retirement changes activation eligibility only, not content or history.

`ai_release_activations` contains one current local `ai_releases` ID and a monotonically increasing
version per tenant. Its FK is composite `(tenant_id, ai_release_id)`. Activating a shared release
copies the frozen content and hash into a new tenant-local frozen `ai_releases` snapshot with
`base_shared_release_id`, then compare-and-swaps the activation row in one transaction. Local
drafts must pass the configured tenant-override policy before becoming activatable.

The repository API is:

```ts
repos(tenant, user, actor).aiConfig = {
  createDraft({ name, manifest, baseSharedReleaseId? }),
  updateDraft({ releaseId, expectedVersion, name?, manifest }),
  freezeDraft({ releaseId, expectedVersion }),
  retireRelease({ releaseId, expectedVersion }),
  getRelease(releaseId), // tenant-local content/hash/status only
  listReleases(),
  listSharedReleases(), // authenticated tenant context; admin policy applies
  getSharedRelease(releaseId), // platform sees all lifecycle states, tenant admin only frozen
  createSharedDraft({ name, manifest, allowedOverridePaths }),
  updateSharedDraft({ releaseId, expectedVersion, name?, manifest, allowedOverridePaths? }),
  freezeSharedDraft({ releaseId, expectedVersion }),
  retireSharedRelease({ releaseId, expectedVersion }),
  activate({ releaseId, expectedActivationVersion }),
  activateShared({ sharedReleaseId, expectedSharedVersion, expectedActivationVersion }),
  getActivation(),
  getPinnedRelease(conversationId),
  getProviderAvailability(provider), // absent row means enabled, version 0
  listProviderAvailability(),
  setProviderAvailability({ provider, enabled, expectedVersion }),
};
```

`actor` is server-only `{ workosUserId, platformAdmin }` from `ResolvedIdentity`. Tenant release
writes additionally verify the local active `users.role='admin'` inside the transaction. Shared
writes verify the WorkOS ID against `PLATFORM_ADMIN_WORKOS_USER_IDS` and set a separate
transaction-local platform GUC. RLS policies use the local tenant role for tenant changes and the
distinct platform GUC for shared writes. Tenant admin never implies platform authority. A local
draft with shared lineage may change only exact JSON-pointer paths in its snapshotted
`allowedOverridePaths`; allowed paths are not wildcard patterns. Tenant provider availability is
a separate mutable policy row (OpenRouter or Anthropic, enabled flag, version, actor); absence
means enabled and changing it never edits a frozen release. All these changes emit tenant audit
events.

## Conversation pins

Conversations carry `configuration_state = 'legacy_unversioned'|'pinned'` and nullable
`ai_release_id`. Existing rows remain `legacy_unversioned`; they are disposable pilot/test data and
are not retroactively pinned. `ensurePinnedConversation({conversationId, schemas})` inserts a new
conversation and copies the current activation release in the same transaction. On an existing
legacy row it returns `legacy_unversioned`, without changing it. Every pinned conversation uses a
composite FK to a local `ai_releases` row in the same tenant. `readPinnedConversation` reads only
the caller's own row; tenant-admin content reads use a separate explicit repository path with a
database role check.

```ts
repos(tenant, user).conversations.ensurePinnedConversation({ conversationId, schemas })
  -> { state: 'pinned'|'legacy_unversioned', snapshot, releaseId? }
repos(tenant, user).conversations.readPinnedConversation(conversationId)
  -> undefined | { state, releaseId?, release: FrozenTenantRelease? }
```

Existing `getOrCreate` remains for compatibility but is not the creation path for new product
conversations after the controller integration.

## Durable turn and trace APIs

A turn key is `(tenant_id, conversation_id, request_id)`. The repository hashes input content
itself. Reuse of a request ID with different input returns `conflict`. One non-responded turn may
run per conversation; row locking and a partial unique index serialize competing requests.

```ts
repos(tenant, user).aiTurns = {
  claimTurn({ conversationId, requestId, inputContent }),
  checkpointTurn({ turnId, ownerToken, expectedVersion, stage, payload }),
  renewTurnLease({ turnId, ownerToken }),
  startAttempt({ turnId, ownerToken, purpose, primaryProfileId, effectiveProfileId,
                 provider, model, modelRevision }),
  attachAttemptRequest({ attemptId, turnId, ownerToken, requestContent }),
  finishAttempt({ attemptId, ownerToken, outcome, responseContent?, usage?, cost? }),
  recordNotice({ turnId, ownerToken, code, content }),
  completeTurn({ turnId, ownerToken, responseContent }),
  getTurn(turnId), listTurns(conversationId), listNotices(turnId), listAttempts({ turnId, purpose? }),
  getUsage({ from?, to? }), deleteTraceContent(turnId),
  adminGetTurn(turnId), adminListTurns({ conversationId?, limit? }),
  adminListAttempts(turnId), adminListNotices(turnId), adminGetUsage({ from?, to? }),
  adminDeleteTraceContent(turnId),
  peekEvents({ conversationId, afterEventId?, limit? }),
  ackEvent({ eventId }),
  settleTaskAndEnqueue({ conversationId, taskId, state, deliverableKind, artifacts, errorCategory? }),
  enqueueSettledTaskEvents({ conversationId, taskId }),
};
systemRepos(tenant).aiEvents.reconcileSettledTasks({ limit? });
systemRepos(tenant).agentTasks.listPendingDispatches({ agentId?, limit? });
```

`claimTurn` returns `acquired` (with owner token, stage, version, payload), `completed`,
`in_progress`, `uncertain`, or `conflict`. It uses a 120-second database-clock lease. An expired
owner can be replaced only at safe checkpoints (`reserved`, `extracted`, or `effects_committed`)
when no provider attempt is still `started`. An expired `effects_started` stage or started
provider attempt becomes `uncertain`; it is never automatically repeated. The old owner token may
still persist a known external outcome after lease expiry unless another safe claimant has taken
ownership. A response failure after `effects_committed` can resume response rendering without
repeating extraction or effects.

`turn.stage` is `reserved`, `extracted`, `effects_started`, `effects_committed`, `responded`, or
`uncertain`. Checkpoints are compare-and-swap by owner token and version. Provider attempts are
inserted as `started` before external calls and finished with outcome, nullable token counts and
nullable cost; null cost means unknown, never zero. Attempt request/response content is separate
from JSONB checkpoint state. A crash with a `started` attempt is ambiguous and blocks retries.

Owners may read their turns and traces. Tenant admins may read/export content within their own
tenant after an explicit local role check. Deletion uses a narrowly scoped database scrub function
that requires an active member and verified tenant admin; it only clears
linked message/provider content, notices, checkpoint payload, and artifact event content. It keeps
request IDs, hashes, pin, stage, and attempt accounting. Scrubbing is rejected for active/recoverable
turns so it cannot erase state needed for safe resume. Shared or tenant audit events retain safe
actor/action/version/hash metadata.
Usage reports keep unknown costs distinct and report that monetary budgets are unconfigured.
The separate event outbox is keyed by a stable event ID (for example `taskId:eventKind`), is
conversation/owner scoped, allows an optional turn ID, and does not participate in the one-active-
turn constraint. Worker enqueue resolves and verifies the conversation owner and task in the
tenant before insert; owner reads/acks are scoped with the caller's user ID. This supports
asynchronous agent completion without holding a new user turn open.

No live migration or database integration test is part of this implementation. The SQL integration
suite must cover tenant isolation, RLS, immutable triggers, activation/pin atomicity, request
idempotency, concurrent activation/turn claims, foreign IDs, audit, and content deletion before
the migration is applied to the configured database.
