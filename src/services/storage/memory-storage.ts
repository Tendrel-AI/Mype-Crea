/** In-memory `IObjectStorage` for tests (KAN-52). Never used at runtime. */
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

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    if (this.failPresign) throw this.failPresign;
    this.presigned.push({ key, ttlSeconds });
    return `https://bucket.test/${key}?X-Amz-Expires=${ttlSeconds}&X-Amz-Signature=fake`;
  }
}
