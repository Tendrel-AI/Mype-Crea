import { afterEach, describe, expect, it, vi } from 'vitest';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BUCKET_ENV_VARS, resolveStorageMode } from '../config';
import { S3ObjectStorage, s3ClientOptions } from '../s3-storage';
import { InMemoryObjectStorage } from '../memory-storage';
import { PRESIGNED_URL_TTL_SECONDS, StorageConfigError } from '../types';
import { getObjectStorage, resetObjectStorage, setObjectStorage } from '../index';
import {
  buildAssetObjectKey,
  extensionForContentType,
  MAX_ASSET_DOWNLOAD_BYTES,
  storeArtifactImages,
} from '../artifact-store';
import { classifyTaskError, TaskError, taskErrorFromThrown } from '../../../core/task-errors';

const FULL_ENV = {
  BUCKET_ENDPOINT: 'https://t3.storageapi.dev',
  BUCKET_NAME: 'creamype-assets-abc123',
  BUCKET_REGION: 'auto',
  BUCKET_ACCESS_KEY: 'synthetic-access-key',
  BUCKET_SECRET_KEY: 'synthetic-secret-key',
};

const IDS = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
  taskId: '33333333-3333-4333-8333-333333333333',
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function imageResponse(bytes: Uint8Array<ArrayBuffer> = PNG, headers: Record<string, string> = { 'content-type': 'image/png' }, status = 200): Response {
  return new Response(bytes, { status, headers });
}

describe('bucket config (fail closed)', () => {
  it('is configured when every BUCKET_* variable is set', () => {
    expect(resolveStorageMode({ ...FULL_ENV, NODE_ENV: 'production' })).toEqual({
      kind: 'configured',
      config: {
        endpoint: FULL_ENV.BUCKET_ENDPOINT,
        bucket: FULL_ENV.BUCKET_NAME,
        region: 'auto',
        accessKeyId: FULL_ENV.BUCKET_ACCESS_KEY,
        secretAccessKey: FULL_ENV.BUCKET_SECRET_KEY,
      },
    });
  });

  it.each(['development', 'test', undefined])('is disabled locally (NODE_ENV=%s) when no variable is set', (nodeEnv) => {
    expect(resolveStorageMode({ NODE_ENV: nodeEnv })).toEqual({ kind: 'disabled' });
  });

  it('throws a typed config error in production when no variable is set', () => {
    expect(() => resolveStorageMode({ NODE_ENV: 'production' })).toThrow(StorageConfigError);
    try {
      resolveStorageMode({ NODE_ENV: 'production' });
    } catch (err) {
      expect((err as StorageConfigError).missing).toEqual([...BUCKET_ENV_VARS]);
      expect(taskErrorFromThrown(err).kind).toBe('config_missing');
    }
  });

  it.each(BUCKET_ENV_VARS.map((name) => [name]))('throws when only %s is missing, in production and locally', (name) => {
    for (const nodeEnv of ['production', 'development']) {
      const env: Record<string, string | undefined> = { ...FULL_ENV, NODE_ENV: nodeEnv, [name]: '  ' };
      expect(() => resolveStorageMode(env)).toThrow(new StorageConfigError([name]).message);
    }
  });
});

describe('S3 client', () => {
  it('uses the endpoint, region and keys from the config, virtual-hosted style', () => {
    const mode = resolveStorageMode(FULL_ENV);
    if (mode.kind !== 'configured') throw new Error('expected configured');
    expect(s3ClientOptions(mode.config)).toMatchObject({
      endpoint: 'https://t3.storageapi.dev',
      region: 'auto',
      credentials: { accessKeyId: 'synthetic-access-key', secretAccessKey: 'synthetic-secret-key' },
      forcePathStyle: false,
    });
  });

  it('presigns a GET for the bucket host with the 15-minute lifetime (offline)', async () => {
    const mode = resolveStorageMode(FULL_ENV);
    if (mode.kind !== 'configured') throw new Error('expected configured');
    const url = new URL(await new S3ObjectStorage(mode.config).presignGet('tenants/t/a.png', PRESIGNED_URL_TTL_SECONDS));
    expect(PRESIGNED_URL_TTL_SECONDS).toBe(900);
    expect(url.host).toBe('creamype-assets-abc123.t3.storageapi.dev');
    expect(url.pathname).toBe('/tenants/t/a.png');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('uploads with the content type through PutObject', async () => {
    const mode = resolveStorageMode(FULL_ENV);
    if (mode.kind !== 'configured') throw new Error('expected configured');
    const client = new S3Client(s3ClientOptions(mode.config));
    const send = vi.spyOn(client, 'send').mockResolvedValue({} as never);
    await new S3ObjectStorage(mode.config, client).putObject('k/0.png', PNG, 'image/png');
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({ Bucket: 'creamype-assets-abc123', Key: 'k/0.png', ContentType: 'image/png' });
  });
});

describe('storage singleton', () => {
  afterEach(() => {
    resetObjectStorage();
    vi.unstubAllEnvs();
  });

  it('is disabled (null) without bucket variables outside production', () => {
    for (const name of BUCKET_ENV_VARS) vi.stubEnv(name, '');
    expect(getObjectStorage()).toBeNull();
  });

  it('fails closed in production without bucket variables', () => {
    for (const name of BUCKET_ENV_VARS) vi.stubEnv(name, '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getObjectStorage()).toThrow(StorageConfigError);
  });

  it('honors the test override', () => {
    const fake = new InMemoryObjectStorage();
    setObjectStorage(fake);
    expect(getObjectStorage()).toBe(fake);
  });
});

describe('object keys', () => {
  it('builds tenants/<t>/conversations/<c>/tasks/<task>/<index>.<ext>', () => {
    expect(buildAssetObjectKey({ ...IDS, index: 0, extension: 'png' })).toBe(
      `tenants/${IDS.tenantId}/conversations/${IDS.conversationId}/tasks/${IDS.taskId}/0.png`,
    );
  });

  it.each([
    { ...IDS, tenantId: '../other' },
    { ...IDS, conversationId: 'a/b' },
    { ...IDS, taskId: '' },
  ])('rejects path-like segments', (ids) => {
    expect(() => buildAssetObjectKey({ ...ids, index: 0, extension: 'png' })).toThrow();
  });

  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/svg+xml', 'svg'],
    ['image/x-icon', 'xicon'],
  ])('maps %s to .%s', (type, ext) => {
    expect(extensionForContentType(type)).toBe(ext);
  });
});

describe('storeArtifactImages', () => {
  const artifact = { kind: 'image', url: 'https://fal.test/out/logo.png', metadata: { provider: 'fal' } };

  it('downloads each URL artifact and stores it under its key before returning', async () => {
    const storage = new InMemoryObjectStorage();
    const fetchImpl = vi.fn(async () => imageResponse()) as unknown as typeof fetch;
    const stored = await storeArtifactImages({ ...IDS, artifacts: [artifact, { kind: 'text', inline: 'x' }] }, { storage, fetchImpl });
    const key = `tenants/${IDS.tenantId}/conversations/${IDS.conversationId}/tasks/${IDS.taskId}/0.png`;
    expect(stored).toEqual([{ ...artifact, storageKey: key }, { kind: 'text', inline: 'x' }]);
    expect(storage.objects.get(key)).toEqual({ bytes: PNG, contentType: 'image/png' });
  });

  it('overwrites the same key when the same task is stored again (idempotent re-upload)', async () => {
    const storage = new InMemoryObjectStorage();
    const fetchImpl = vi.fn(async () => imageResponse()) as unknown as typeof fetch;
    const first = await storeArtifactImages({ ...IDS, artifacts: [artifact] }, { storage, fetchImpl });
    const second = await storeArtifactImages({ ...IDS, artifacts: [artifact] }, { storage, fetchImpl });
    expect(second).toEqual(first);
    expect(storage.objects.size).toBe(1);
  });

  it('passes artifacts through unchanged when storage is disabled', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await storeArtifactImages({ ...IDS, artifacts: [artifact] }, { storage: null, fetchImpl })).toEqual([artifact]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['an HTTP error', () => imageResponse(PNG, { 'content-type': 'image/png' }, 503)],
    ['a non-image content type', () => imageResponse(PNG, { 'content-type': 'text/html' })],
    ['a declared size over the cap', () => imageResponse(PNG, { 'content-type': 'image/png', 'content-length': String(MAX_ASSET_DOWNLOAD_BYTES + 1) })],
    ['an empty body', () => imageResponse(new Uint8Array(0))],
  ])('fails with storage_unavailable (transient) on %s and stores nothing', async (_label, respond) => {
    const storage = new InMemoryObjectStorage();
    const fetchImpl = vi.fn(async () => respond()) as unknown as typeof fetch;
    const error = await storeArtifactImages({ ...IDS, artifacts: [artifact] }, { storage, fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskError);
    expect((error as TaskError).kind).toBe('storage_unavailable');
    expect(classifyTaskError(error as TaskError)).toBe('transient');
    expect(storage.objects.size).toBe(0);
  });

  it('enforces the size cap on the streamed body when no length is declared', async () => {
    const storage = new InMemoryObjectStorage();
    const fetchImpl = vi.fn(async () => imageResponse(new Uint8Array(64))) as unknown as typeof fetch;
    const error = await storeArtifactImages({ ...IDS, artifacts: [artifact] }, { storage, fetchImpl, maxBytes: 16 }).catch((e: unknown) => e);
    expect((error as TaskError).kind).toBe('storage_unavailable');
    expect((error as TaskError).message).toMatch(/too large/);
  });

  it('times out a download that does not answer', async () => {
    const fetchImpl = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const error = await storeArtifactImages({ ...IDS, artifacts: [artifact] }, { storage: new InMemoryObjectStorage(), fetchImpl, timeoutMs: 5 })
      .catch((e: unknown) => e);
    expect((error as TaskError).kind).toBe('storage_unavailable');
    expect((error as TaskError).message).toMatch(/timed out/);
  });

  it('rejects non-https provider URLs without fetching', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const error = await storeArtifactImages({ ...IDS, artifacts: [{ ...artifact, url: 'http://fal.test/x.png' }] }, { storage: new InMemoryObjectStorage(), fetchImpl })
      .catch((e: unknown) => e);
    expect((error as TaskError).kind).toBe('storage_unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails with storage_unavailable when the upload fails', async () => {
    const storage = new InMemoryObjectStorage();
    storage.failPuts = new Error('bucket down');
    const fetchImpl = vi.fn(async () => imageResponse()) as unknown as typeof fetch;
    const error = await storeArtifactImages({ ...IDS, artifacts: [artifact] }, { storage, fetchImpl }).catch((e: unknown) => e);
    expect((error as TaskError).kind).toBe('storage_unavailable');
  });

  it('propagates the production config error from the service (config_missing)', async () => {
    resetObjectStorage();
    for (const name of BUCKET_ENV_VARS) vi.stubEnv(name, '');
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const error = await storeArtifactImages({ ...IDS, artifacts: [artifact] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageConfigError);
      expect(taskErrorFromThrown(error).kind).toBe('config_missing');
    } finally {
      vi.unstubAllEnvs();
      resetObjectStorage();
    }
  });
});
