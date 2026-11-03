[← Features](README.md)

# Assets and storage

## What it does

Every generated logo is copied into a private bucket before the user is told it is ready. The
browser always loads it from `/api/assets/<deliverableId>`, which works only for the logo's
owner and hands out a short-lived signed link. Every image is kept.

## How it works

1. **Configure.** `src/services/storage/config.ts:resolveStorageMode` reads the five `BUCKET_*`
   variables (`BUCKET_ENV_VARS`): all set → S3 (Railway Storage Bucket); none set outside
   production → storage off, provider URL kept, one warning; none in production or a partial
   set anywhere → `StorageConfigError` (`config_missing`), so logo tasks fail closed.
   `src/services/storage/index.ts:getObjectStorage` builds the client.
2. **Port.** `src/services/storage/types.ts:IObjectStorage` (`putObject`, `presignGet`), with
   `src/services/storage/s3-storage.ts:S3ObjectStorage` (AWS SDK, virtual-hosted style) and
   `src/services/storage/memory-storage.ts:InMemoryObjectStorage` for tests.
3. **Persist before available.** After the handler returns, the logo worker
   (`src/workers/logo-agent-worker.ts`) calls
   `src/services/storage/artifact-store.ts:storeArtifactImages`: download each artifact URL
   (HTTPS only, `image/*`, ≤ 15 MiB via `MAX_ASSET_DOWNLOAD_BYTES`, 20 s timeout), then upload
   under the key from `buildAssetObjectKey`:
   `tenants/<tenantId>/conversations/<conversationId>/tasks/<taskId>/<index>.<ext>`.
   Any failure throws `TaskError('storage_unavailable')` (classified `transient`), and the task
   fails durably with no artifacts.
4. **Record.** `settleTaskAndEnqueue` (`src/repos/ai-turns.ts`) writes `deliverables.storage_key`
   in the settlement transaction; `content_url` keeps the provider URL as provenance only
   (migration `migrations/1792800004000_deliverable-storage-key.js`, with a CHECK that the key
   starts with `tenants/<tenant_id>/`).
5. **Expose.** `src/core/deliverable-url.ts:clientDeliverableUrl` is the one rule for what a
   client sees: a row with a key → `/api/assets/<id>` (`assetRoutePath`); otherwise
   `contentUrl`. It is used by the reload and export actions, the deliverable state views, live
   and rebuilt completion notices, and the worker's settled artifacts.
6. **Serve.** `app/api/assets/[id]/route.ts:GET`: non-UUID → 404 before identity; no session →
   401; key lookup through `repos(tenant, user).deliverables.findOwnStorageKey`
   (`src/repos/deliverables.ts`, RLS plus an explicit owner filter) → 404 for unknown, foreign,
   other-member and keyless rows alike; then 302 to `presignGet(key, PRESIGNED_URL_TTL_SECONDS)`
   (15 minutes). Lookup or signing failure → 503. Every response has
   `Cache-Control: private, no-store`. Image bytes never pass through the app.

## Key rules / invariants

- **Nothing is announced as available before its image is stored.** Enforced by
  `src/workers/__tests__/logo-agent-worker.test.ts` ("uploads the image before the durable
  settlement and announces only the asset route", "fails with config_missing when the bucket is
  not configured in production").
- **Provider and presigned URLs never reach state, decisions, events or the outbox.** Only
  `/api/assets/<id>` leaves the server. Enforced by `src/core/__tests__/deliverable-url.test.ts`.
- **Only the owner can open an asset; every miss looks the same (404).** A tenant admin cannot
  open a member's logo through the route. Enforced by
  `app/api/assets/[id]/__tests__/route.test.ts` and the KAN-52 case in
  `src/core/__tests__/cross-tenant-isolation.integration.test.ts`.
- **Keys are namespaced by tenant, in code and in SQL.** Enforced by
  `src/services/storage/__tests__/storage.test.ts` ("builds tenants/<t>/conversations/…") and
  the database CHECK `deliverables_storage_key_tenant_prefix`.
- **Missing configuration fails closed in production.** Enforced by `storage.test.ts`.

## Decisions

- 2026-10-25 — KAN-52 (owner): private Railway bucket, authorized route, 15-minute presigned
  links, keep every image (no cleanup, no delete path), configured only by the five `BUCKET_*`
  variables. Runbook: [`docs/operations.md`](../operations.md) §9 "Private asset storage".
- Backup coverage of assets depends on KAN-67, **proposed, awaiting owner approval**
  ([`pipeline/decisions/KAN-67-rpo-rto-backup-scope.md`](../../pipeline/decisions/KAN-67-rpo-rto-backup-scope.md)).

## Limits & known gaps

- The `BUCKET_*` variables are not yet set on any Railway environment, and path-style versus
  virtual-hosted behavior has not been tested against the real bucket (see the operations guide).
- An upload whose settlement then fails leaves an orphan object (accepted under keep-everything
  retention).
- Without Redis (local path) nothing is persisted, so deliverables keep the provider URL.
- Rows written before KAN-52 have no key and still show their provider URL.

## See also

- [02-agents-and-transport.md](02-agents-and-transport.md) — the worker that uploads
- [05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md) — the identity behind the route
- [`docs/personal-data.md`](../personal-data.md) — processors that receive data
