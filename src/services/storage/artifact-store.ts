/**
 * Copy generated images into private object storage before settlement (KAN-52).
 *
 * The logo worker calls `storeArtifactImages` after the handler returns and
 * BEFORE the durable settlement, so a deliverable row exists only once its
 * image is in the bucket. Each URL artifact is downloaded from the provider
 * (bounded: timeout, size cap, `image/*` content type) and written under
 *
 *   tenants/<tenantId>/conversations/<conversationId>/tasks/<taskId>/<index>.<ext>
 *
 * The key is deterministic per task and artifact position, so a re-run of the
 * same task overwrites the same object (idempotent). Any download or upload
 * failure throws `TaskError('storage_unavailable')` (classified `transient`,
 * so the user gets Reintentar); missing bucket config in production throws
 * `StorageConfigError` (`config_missing`). Nothing is half-stored: the caller
 * settles the task as failed and writes no deliverable.
 *
 * Without bucket variables outside production (local dev) the artifacts pass
 * through unchanged and keep the provider URL.
 */
import type { A2AArtifact } from '../../core/agent-types';
import { TaskError } from '../../core/task-errors';
import { getObjectStorage } from './index';
import type { IObjectStorage, StoredArtifact } from './types';

/** Largest image the worker downloads from the provider. */
export const MAX_ASSET_DOWNLOAD_BYTES = 15 * 1024 * 1024;
/** Whole-download budget (headers and body). */
export const ASSET_DOWNLOAD_TIMEOUT_MS = 20_000;

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

const KEY_SEGMENT = /^[A-Za-z0-9-]+$/;

/** File extension for an `image/*` content type. */
export function extensionForContentType(contentType: string): string {
  const known = EXTENSION_BY_TYPE[contentType];
  if (known) return known;
  const subtype = contentType.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? '';
  return subtype || 'img';
}

/** The object key of one task artifact. IDs must be plain identifiers (no path tricks). */
export function buildAssetObjectKey(input: {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly taskId: string;
  readonly index: number;
  readonly extension: string;
}): string {
  for (const segment of [input.tenantId, input.conversationId, input.taskId, input.extension]) {
    if (!KEY_SEGMENT.test(segment)) throw new Error('Invalid object key segment.');
  }
  if (!Number.isInteger(input.index) || input.index < 0) throw new Error('Invalid object key index.');
  return `tenants/${input.tenantId}/conversations/${input.conversationId}/tasks/${input.taskId}/${input.index}.${input.extension}`;
}

export interface StoreArtifactImagesInput {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly taskId: string;
  readonly artifacts: ReadonlyArray<A2AArtifact>;
}

export interface StoreArtifactImagesOptions {
  /** `null` = storage disabled (pass through). Omitted = the configured service. */
  readonly storage?: IObjectStorage | null;
  readonly fetchImpl?: typeof fetch;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export type StoreArtifactImages = (input: StoreArtifactImagesInput) => Promise<ReadonlyArray<StoredArtifact>>;

export async function storeArtifactImages(
  input: StoreArtifactImagesInput,
  options: StoreArtifactImagesOptions = {},
): Promise<ReadonlyArray<StoredArtifact>> {
  // Resolved per call: in production a missing config throws StorageConfigError here.
  const storage = options.storage !== undefined ? options.storage : getObjectStorage();
  if (!storage) return input.artifacts;

  const stored: StoredArtifact[] = [];
  for (const [index, artifact] of input.artifacts.entries()) {
    if (!artifact.url) {
      stored.push(artifact);
      continue;
    }
    const image = await downloadImage(artifact.url, {
      fetchImpl: options.fetchImpl ?? fetch,
      maxBytes: options.maxBytes ?? MAX_ASSET_DOWNLOAD_BYTES,
      timeoutMs: options.timeoutMs ?? ASSET_DOWNLOAD_TIMEOUT_MS,
    });
    const storageKey = buildAssetObjectKey({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      index,
      extension: extensionForContentType(image.contentType),
    });
    try {
      await storage.putObject(storageKey, image.bytes, image.contentType);
    } catch (err) {
      throw new TaskError('storage_unavailable', 'Could not upload the image to object storage.', { cause: err });
    }
    stored.push({ ...artifact, storageKey });
  }
  return stored;
}

async function downloadImage(
  url: string,
  limits: { readonly fetchImpl: typeof fetch; readonly maxBytes: number; readonly timeoutMs: number },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const fail = (reason: string, cause?: unknown): never => {
    throw new TaskError('storage_unavailable', `Could not download the generated image: ${reason}.`, { cause });
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    return fail('invalid URL', err);
  }
  if (parsed.protocol !== 'https:') fail('only https URLs are accepted');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    let response: Response;
    try {
      response = await limits.fetchImpl(parsed, { signal: controller.signal, redirect: 'follow' });
    } catch (err) {
      return fail(controller.signal.aborted ? 'timed out' : 'network error', err);
    }
    if (!response.ok) fail(`HTTP ${response.status}`);
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) fail('the response is not an image');
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > limits.maxBytes) fail('the image is too large');
    if (!response.body) fail('empty response');

    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limits.maxBytes) {
          await reader.cancel().catch(() => undefined);
          fail('the image is too large');
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof TaskError) throw err;
      return fail(controller.signal.aborted ? 'timed out' : 'read error', err);
    }
    if (total === 0) fail('empty response');

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, contentType };
  } finally {
    clearTimeout(timer);
  }
}
