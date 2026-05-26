/**
 * ImageGeneratorService — the consumer-facing image abstraction.
 *
 * Holds a default IImageProvider plus an optional purpose → provider map.
 * Routes a request to the matching provider, logs lifecycle under
 * `service.image.generator`, and stamps `latencyMs` on the result so callers
 * don't measure independently.
 *
 * Adding a vendor for one purpose later (e.g., social banners on Imagen) is
 * `registerForPurpose('social', new ImagenProvider(...))`. No consumer change.
 */
import { loggerFor } from '../logger';
import type { IImageGenerator, IImageProvider, ImagePurpose, ImageRequest, ImageResult } from './types';

const log = loggerFor('service.image.generator');

export class ImageGeneratorService implements IImageGenerator {
  private readonly providersByPurpose = new Map<ImagePurpose, IImageProvider>();

  constructor(private readonly defaultProvider: IImageProvider) {}

  registerForPurpose(purpose: ImagePurpose, provider: IImageProvider): void {
    this.providersByPurpose.set(purpose, provider);
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const provider =
      (req.purpose && this.providersByPurpose.get(req.purpose)) ?? this.defaultProvider;
    const child = log.child({
      providerId: provider.id,
      purpose: req.purpose ?? null,
      isEdit: Boolean(req.referenceUrls && req.referenceUrls.length > 0),
    });
    child.info('image.generate.start');
    const t0 = Date.now();
    let result: ImageResult;
    try {
      result = await provider.generate(req);
    } catch (err) {
      child.error({ err, latencyMs: Date.now() - t0 }, 'image.generate.failed');
      throw err;
    }
    const latencyMs = Date.now() - t0;
    child.info({ latencyMs, modelId: result.modelId }, 'image.generate.complete');
    // Trust the provider's latency if it stamped one; otherwise use ours.
    return result.latencyMs > 0 ? result : { ...result, latencyMs };
  }
}
