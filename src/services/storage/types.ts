/**
 * Object storage port (KAN-52).
 *
 * Generated images are copied into a private, S3-compatible bucket (the
 * Railway Storage Bucket) before a deliverable becomes visible. The browser
 * never gets the object directly: it asks `GET /api/assets/<deliverableId>`,
 * which authorizes the caller and redirects to a short-lived presigned URL.
 *
 * Implementations: `S3ObjectStorage` (production) and `InMemoryObjectStorage`
 * (tests). Retention is "keep everything" for the pilot, so the port has no
 * delete operation on purpose.
 */
import type { A2AArtifact } from '../../core/agent-types';
import { TaskError } from '../../core/task-errors';

/**
 * A handler artifact after the worker copied its image into the bucket.
 * `storageKey` is set only when the object was stored; the artifact `url`
 * stays the provider URL (kept in `deliverables.content_url` for provenance,
 * never sent to the client once a key exists).
 */
export type StoredArtifact = A2AArtifact & { readonly storageKey?: string };

/** Lifetime of every presigned GET URL the app hands out (owner decision: 15 minutes). */
export const PRESIGNED_URL_TTL_SECONDS = 15 * 60;

export interface IObjectStorage {
  /** Write (or overwrite) one object. Same key = idempotent overwrite. */
  putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** A presigned GET URL for `key`, valid for `ttlSeconds`. */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
}

/**
 * Bucket configuration is missing or incomplete where it is required.
 * Carries the `config_missing` task error kind, so a task that could not be
 * stored because of it fails with that kind (never with a provider URL).
 */
export class StorageConfigError extends TaskError {
  constructor(readonly missing: ReadonlyArray<string>) {
    super('config_missing', `Object storage is not configured; missing ${missing.join(', ')}.`);
    this.name = 'StorageConfigError';
  }
}
