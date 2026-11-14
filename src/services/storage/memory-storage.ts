/** In-memory `IObjectStorage` for tests (KAN-52). Also the local-dev fallback for brand uploads (KAN-87). */
import type { IObjectStorage } from './types';

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export class InMemoryObjectStorage implements IObjectStorage {
  readonly objects = new Map<string, StoredObject>();
  readonly presigned: Array<{ key: string; ttlSeconds: number }> = [];
  /** Set to make the next calls fail (simulates an unavailable bucket). */
  failPuts: Error | null = null;
  failPresign: Error | null = null;

  async putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (this.failPuts) throw this.failPuts;
    this.objects.set(key, { bytes, contentType });
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    if (this.failPresign) throw this.failPresign;
    this.presigned.push({ key, ttlSeconds });
    return `https://bucket.test/${key}?X-Amz-Expires=${ttlSeconds}&X-Amz-Signature=fake`;
  }
}
