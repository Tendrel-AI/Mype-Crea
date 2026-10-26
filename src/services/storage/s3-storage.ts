/**
 * S3-compatible implementation of `IObjectStorage` for the Railway Storage
 * Bucket (KAN-52).
 *
 * `forcePathStyle: false` (virtual-hosted style, the SDK default): Railway's
 * bucket docs state that buckets use virtual-hosted–style URLs and that the
 * client only needs the base endpoint (e.g. `https://t3.storageapi.dev`).
 * Only buckets created before that change may need path style; their
 * Credentials tab says so.
 *
 * Checksums are computed/validated only when an operation requires them:
 * recent AWS SDK versions add CRC checksum headers by default, which
 * S3-compatible providers do not all accept.
 */
import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BucketConfig } from './config';
import type { IObjectStorage } from './types';

/** S3 client options for a bucket config. Exported for the config test. */
export function s3ClientOptions(config: BucketConfig) {
  return {
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: false,
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
}

export class S3ObjectStorage implements IObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: BucketConfig, client?: S3Client) {
    this.client = client ?? new S3Client(s3ClientOptions(config));
    this.bucket = config.bucket;
  }

  async putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType }),
    );
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }
}
