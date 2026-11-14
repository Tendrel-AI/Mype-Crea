/** Local-dev `IObjectStorage` on disk (D32): survives `next dev` restarts. Never used with a bucket configured. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { IObjectStorage } from './types';

export class DiskObjectStorage implements IObjectStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Keys are `tenants/.../files/<uuid>.<ext>`; anything that could leave the root is refused. */
  private pathOf(key: string): string {
    const path = resolve(this.root, key);
    if (!key || isAbsolute(key) || key.split(/[\\/]/).includes('..') || !path.startsWith(this.root + sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path;
  }

  async putObject(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathOf(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async presignGet(): Promise<string> {
    throw new Error('Disk storage cannot presign URLs; brand files are streamed by the app.');
  }
}
