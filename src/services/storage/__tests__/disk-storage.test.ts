import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskObjectStorage } from '../disk-storage';

describe('DiskObjectStorage (D32 dev fallback)', () => {
  let dir: string;
  let storage: DiskObjectStorage;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'disk-storage-'));
    storage = new DiskObjectStorage(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('put/get/delete roundtrip; a missing key reads null and deleting it is fine', async () => {
    const key = 'tenants/t/brands/b/files/f.pdf';
    await storage.putObject(key, new Uint8Array([1, 2, 3]));
    expect(await storage.getObject(key)).toEqual(new Uint8Array([1, 2, 3]));
    // A new instance (a restart) still sees it.
    expect(await new DiskObjectStorage(dir).getObject(key)).toEqual(new Uint8Array([1, 2, 3]));
    await storage.deleteObject(key);
    expect(await storage.getObject(key)).toBeNull();
    await expect(storage.deleteObject(key)).resolves.toBeUndefined();
  });

  it.each(['../escape.pdf', 'a/../../escape.pdf', '/etc/passwd', ''])('rejects the key %j', async (key) => {
    await expect(storage.putObject(key, new Uint8Array([1]))).rejects.toThrow(/Invalid storage key/);
    await expect(storage.getObject(key)).rejects.toThrow(/Invalid storage key/);
  });
});
