/**
 * Module-level object storage singleton (KAN-52). Same pattern as
 * `src/services/image`: lazy construction so importing this module never
 * needs the bucket variables, plus `setObjectStorage` / `resetObjectStorage`
 * for tests.
 *
 * `getObjectStorage()` returns:
 *   - an `S3ObjectStorage` when every BUCKET_* variable is set;
 *   - `null` locally when none is set (storage disabled: deliverables keep
 *     the provider URL; one warning is logged per process);
 *   - throws `StorageConfigError` when the config is missing in production
 *     or half-filled anywhere (fail closed; never cached, so fixing the
 *     variables and restarting is enough).
 */
import { loggerFor } from '../logger';
import { resolveStorageMode } from './config';
import { S3ObjectStorage } from './s3-storage';
import type { IObjectStorage } from './types';

export { PRESIGNED_URL_TTL_SECONDS, StorageConfigError } from './types';
export type { IObjectStorage, StoredArtifact } from './types';

const log = loggerFor('services.storage');

let override: IObjectStorage | null | undefined;
let cached: IObjectStorage | null | undefined;
let warnedDisabled = false;

export function getObjectStorage(): IObjectStorage | null {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  const mode = resolveStorageMode();
  if (mode.kind === 'disabled') {
    if (!warnedDisabled) {
      warnedDisabled = true;
      log.warn('services.storage.disabled_no_bucket_env: generated images keep the provider URL');
    }
    cached = null;
    return null;
  }
  cached = new S3ObjectStorage(mode.config);
  return cached;
}

/** Test hook: force a storage (or `null` = disabled) instead of the environment. */
export function setObjectStorage(storage: IObjectStorage | null): void {
  override = storage;
}

/** Test hook: back to the environment-driven singleton. */
export function resetObjectStorage(): void {
  override = undefined;
  cached = undefined;
  warnedDisabled = false;
}
