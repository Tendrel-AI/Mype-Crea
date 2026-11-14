/**
 * Image-generation service abstractions.
 *
 * Two layers split deliberately so vendor swaps and per-purpose routing are
 * both cheap:
 *
 *   IImageGenerator   — consumer-facing. Routes by `purpose`, owns latency
 *                       measurement and structured logging. Handlers and
 *                       server actions depend on this interface only.
 *
 *   IImageProvider    — vendor adapter (fal, Replicate, OpenAI Images, …).
 *                       Thin: just calls the SDK, returns a URL. No purpose
 *                       awareness, no retries, no normalization — that lives
 *                       one layer up.
 *
 * Adding a new vendor: implement IImageProvider + register it on the
 * generator. Consumers stay untouched.
 */

import type { SafetyRecord } from '../../core/deliverable-safety';

export type ImagePurpose = 'logo' | 'label' | 'social';

export interface ImageRequest {
  readonly prompt: string;
  /** Empty/absent → base model; non-empty → vendor's edit/refine endpoint. */
  readonly referenceUrls?: ReadonlyArray<string>;
  readonly purpose?: ImagePurpose;
  /**
   * KAN-43: who pays for this image. Required whenever the generator has a usage gate (always
   * in production); the gate resolves the conversation owner from the task.
   */
  readonly usage?: ImageUsageScope;
}

export interface ImageUsageScope {
  readonly tenantId: string;
  readonly agentTaskId: string;
}

export interface ImageResult {
  readonly url: string;
  /** Stable provider id (e.g. 'fal'). Surfaced for audit logs and artifact metadata. */
  readonly providerId: string;
  /** Vendor-specific model slug (e.g. 'fal-ai/flux-2'). */
  readonly modelId: string;
  readonly latencyMs: number;
  /** KAN-33: the provider's safety classifier result for this image. Required: no image is unclassified. */
  readonly safety: SafetyRecord;
}

export interface IImageProvider {
  readonly id: string;
  /** USD per image of this provider's model: what the usage gate reserves and settles (KAN-43). */
  readonly priceUsd: number;
  generate(req: ImageRequest): Promise<ImageResult>;
}

export interface IImageGenerator {
  generate(req: ImageRequest): Promise<ImageResult>;
}
