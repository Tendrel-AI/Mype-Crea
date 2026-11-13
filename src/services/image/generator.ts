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
import { TaskError } from '../../core/task-errors';
import { loggerFor } from '../logger';
import { runWithUsage, UsageLimitError, type UsageLedger } from '../usage/gateway';
import { IMAGE_PRICE_USD } from '../usage/policy';
import type { IImageGenerator, IImageProvider, ImagePurpose, ImageRequest, ImageResult, ImageUsageScope } from './types';

/** KAN-43: the ledger of the user who pays for an image, plus its conversation for correlation. */
export type ImageUsageResolver = (scope: ImageUsageScope) => Promise<{ readonly ledger: UsageLedger; readonly conversationId?: string }>;

const log = loggerFor('service.image.generator');

export class ImageGeneratorService implements IImageGenerator {
  private readonly providersByPurpose = new Map<ImagePurpose, IImageProvider>();

  constructor(
    private readonly defaultProvider: IImageProvider,
    private readonly usageFor?: ImageUsageResolver,
  ) {}

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
      result = await this.gated(provider, req);
    } catch (err) {
      child.error({ err, latencyMs: Date.now() - t0 }, 'image.generate.failed');
      throw err;
    }
    const latencyMs = Date.now() - t0;
    child.info({ latencyMs, modelId: result.modelId }, 'image.generate.complete');
    // Trust the provider's latency if it stamped one; otherwise use ours.
    return result.latencyMs > 0 ? result : { ...result, latencyMs };
  }

  /** Every provider call reserves first when a gate is configured (always in production). */
  private async gated(provider: IImageProvider, req: ImageRequest): Promise<ImageResult> {
    if (!this.usageFor) return provider.generate(req);
    if (!req.usage) throw new TaskError('config_missing', 'Image request has no usage scope; refusing an ungated provider call.');
    const { ledger, conversationId } = await this.usageFor(req.usage);
    try {
      return await runWithUsage(ledger, {
        request: {
          kind: 'image',
          estimatedCostUsd: IMAGE_PRICE_USD,
          provider: provider.id,
          conversationId,
          agentTaskId: req.usage.agentTaskId,
        },
        call: () => provider.generate(req),
        actualCost: () => ({ usd: IMAGE_PRICE_USD, source: 'flat' }),
        // A typed rejection was not billed; a timeout or untyped failure may have been.
        failureCostUsd: (error) => error instanceof TaskError && error.kind !== 'timeout' ? 0 : IMAGE_PRICE_USD,
      });
    } catch (error) {
      if (error instanceof UsageLimitError) throw new TaskError('usage_limited', error.userMessage, { cause: error });
      throw error;
    }
  }
}
