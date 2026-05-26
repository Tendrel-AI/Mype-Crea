/**
 * fal.ai-backed IImageProvider.
 *
 * The only place in the codebase that imports `@fal-ai/client`. Picks
 * `nano-banana-2/edit` when reference images are provided, `nano-banana-2`
 * otherwise. Logs request lifecycle under scope `service.image.fal`.
 */
import { fal } from '@fal-ai/client';
import { loggerFor } from '../logger';
import type { IImageProvider, ImageRequest, ImageResult } from './types';

const log = loggerFor('service.image.fal');
const PROVIDER_ID = 'fal';
const BASE_MODEL = 'fal-ai/nano-banana-2';
const EDIT_MODEL = 'fal-ai/nano-banana-2/edit';

export class FalImageProvider implements IImageProvider {
  readonly id = PROVIDER_ID;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('FAL_KEY is not set. The fal image provider requires a fal.ai API key.');
    }
    fal.config({ credentials: apiKey });
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const isEdit = Boolean(req.referenceUrls && req.referenceUrls.length > 0);
    const modelId = isEdit ? EDIT_MODEL : BASE_MODEL;

    const input: Record<string, unknown> = { prompt: req.prompt };
    if (isEdit) {
      input.image_urls = req.referenceUrls;
    }

    const child = log.child({ modelId, isEdit });
    child.info({ promptLength: req.prompt.length }, 'image.request.start');
    const t0 = Date.now();
    let result;
    try {
      result = await fal.subscribe(modelId, { input });
    } catch (err) {
      child.error({ err, latencyMs: Date.now() - t0 }, 'image.request.failed');
      throw err;
    }
    const latencyMs = Date.now() - t0;
    const url = (result.data as { images?: Array<{ url?: string }> } | undefined)?.images?.[0]?.url;
    if (!url) {
      child.error({ latencyMs }, 'image.request.no_url');
      throw new Error('fal returned no image URL');
    }
    child.info({ latencyMs }, 'image.request.complete');
    return { url, providerId: this.id, modelId, latencyMs };
  }
}
