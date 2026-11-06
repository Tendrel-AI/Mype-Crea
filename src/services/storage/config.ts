/**
 * Bucket configuration from the environment (KAN-52).
 *
 * The Railway service exposes exactly these variables: `BUCKET_ENDPOINT`,
 * `BUCKET_NAME`, `BUCKET_REGION`, `BUCKET_ACCESS_KEY`, `BUCKET_SECRET_KEY`.
 *
 * Rules (fail closed):
 *   - all five set                       -> `configured`
 *   - none set, NODE_ENV !== production  -> `disabled` (local dev keeps the
 *                                           provider URL; the caller logs once)
 *   - none set in production             -> StorageConfigError
 *   - some set, some missing (anywhere)  -> StorageConfigError (a half-filled
 *                                           config is a mistake, not "off")
 */
import { StorageConfigError } from './types';

export const BUCKET_ENV_VARS = [
  'BUCKET_ENDPOINT',
  'BUCKET_NAME',
  'BUCKET_REGION',
  'BUCKET_ACCESS_KEY',
  'BUCKET_SECRET_KEY',
] as const;

export interface BucketConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type StorageMode =
  | { readonly kind: 'configured'; readonly config: BucketConfig }
  | { readonly kind: 'disabled' };

type Env = Readonly<Record<string, string | undefined>>;

export function resolveStorageMode(env: Env = process.env): StorageMode {
  const value = (name: (typeof BUCKET_ENV_VARS)[number]): string => env[name]?.trim() ?? '';
  const missing = BUCKET_ENV_VARS.filter((name) => value(name) === '');

  if (missing.length === 0) {
    return {
      kind: 'configured',
      config: {
        endpoint: value('BUCKET_ENDPOINT'),
        bucket: value('BUCKET_NAME'),
        region: value('BUCKET_REGION'),
        accessKeyId: value('BUCKET_ACCESS_KEY'),
        secretAccessKey: value('BUCKET_SECRET_KEY'),
      },
    };
  }
  if (missing.length === BUCKET_ENV_VARS.length && env.NODE_ENV !== 'production') {
    return { kind: 'disabled' };
  }
  throw new StorageConfigError(missing);
}
