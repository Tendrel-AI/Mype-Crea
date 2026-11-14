/**
 * fal.ai-backed IImageProvider.
 *
 * The only place in the codebase that imports `@fal-ai/client`. The model comes from `IMAGE_MODEL` (D63):
 * `nano-banana-2` (default, Gemini 3.1 Flash Image) or `klein` (FLUX.3 Klein, D59). Each has a base endpoint and
 * an edit endpoint used when reference images are provided; always square 1K. Logs request lifecycle under scope `service.image.fal`.
 *
 * Failures are rethrown as `TaskError` with a typed kind whenever the fal
 * error carries a usable signal (HTTP status, content-policy detail, timeout,
 * network failure), so the task's `error_category` is classified correctly
 * (architecture §2.5). Errors without such a signal are rethrown unchanged.
 *
 * Safety (KAN-33): Klein runs fal's safety checker and its `has_nsfw_concepts[0]` becomes the image's
 * `SafetyRecord` (`falSafety`): false → passed, true → rejected (`sexual_content`), anything else → indeterminate.
 * Gemini returns no flag: Google's filter (at `safety_tolerance` 2, strict) refuses unsafe requests before any image
 * exists, so a returned image is recorded as passed by that filter (`providerFilterSafety`).
 */
import { fal } from '@fal-ai/client';
import { SAFETY_POLICY_VERSION, type SafetyRecord } from '../../core/deliverable-safety';
import { TaskError } from '../../core/task-errors';
import { loggerFor } from '../logger';
import { IMAGE_PRICES_USD, type ImageModelKey } from '../usage/policy';
import type { IImageProvider, ImageRequest, ImageResult } from './types';

const log = loggerFor('service.image.fal');
const PROVIDER_ID = 'fal';
const SAFETY_CLASSIFIER = 'fal-safety-checker';
const GEMINI_SAFETY_CLASSIFIER = 'google-gemini-safety-filter';

/** fal endpoints and fixed input of each selectable model. */
const IMAGE_MODELS: Readonly<Record<ImageModelKey, { base: string; edit: string; input: Readonly<Record<string, unknown>>; flagsNsfw: boolean }>> = {
  'nano-banana-2': {
    base: 'fal-ai/nano-banana-2',
    edit: 'fal-ai/nano-banana-2/edit',
    input: { aspect_ratio: '1:1', resolution: '1K', output_format: 'png', safety_tolerance: '2' },
    flagsNsfw: false,
  },
  klein: {
    base: 'blackforestlabs/flux-3/klein/text-to-image',
    edit: 'blackforestlabs/flux-3/klein/edit-image',
    // The art director's prompt is final (exact brand-name spelling, D46): Klein's prompt expansion would rewrite it.
    input: { image_size: 'square_hd', enable_safety_checker: true, enable_prompt_expansion: false },
    flagsNsfw: true,
  },
};
export const DEFAULT_IMAGE_MODEL: ImageModelKey = 'nano-banana-2';

/** `IMAGE_MODEL` (unset → default). An unknown value fails loudly instead of silently billing another model. */
export function readImageModel(env: Readonly<Record<string, string | undefined>> = process.env): ImageModelKey {
  const value = env.IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
  if (!(value in IMAGE_MODELS)) {
    throw new TaskError('config_missing', `IMAGE_MODEL "${value}" is not one of: ${Object.keys(IMAGE_MODELS).join(', ')}.`);
  }
  return value as ImageModelKey;
}

export class FalImageProvider implements IImageProvider {
  readonly id = PROVIDER_ID;
  readonly priceUsd: number;

  constructor(apiKey: string, private readonly model: ImageModelKey = readImageModel()) {
    this.priceUsd = IMAGE_PRICES_USD[model];
    if (!apiKey) {
      throw new TaskError(
        'config_missing',
        'FAL_KEY is not set. The fal image provider requires a fal.ai API key.',
      );
    }
    fal.config({ credentials: apiKey });
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const isEdit = Boolean(req.referenceUrls && req.referenceUrls.length > 0);
    const spec = IMAGE_MODELS[this.model];
    const modelId = isEdit ? spec.edit : spec.base;

    const input = {
      prompt: req.prompt,
      ...spec.input,
      ...(isEdit ? { image_urls: await Promise.all(req.referenceUrls!.map(toFalUrl)) } : {}),
    };

    const child = log.child({ modelId, isEdit });
    child.info({ promptLength: req.prompt.length }, 'image.request.start');
    const t0 = Date.now();
    let result;
    try {
      result = await fal.subscribe(modelId, { input });
    } catch (err) {
      const typed = classifyFalError(err);
      child.error(
        { err, latencyMs: Date.now() - t0, errorKind: typed?.kind ?? null },
        'image.request.failed',
      );
      throw typed ?? err;
    }
    const latencyMs = Date.now() - t0;
    const url = (result.data as { images?: Array<{ url?: string }> } | undefined)?.images?.[0]?.url;
    if (!url) {
      child.error({ latencyMs }, 'image.request.no_url');
      throw new TaskError('invalid_output', 'fal returned no image URL');
    }
    const safety = spec.flagsNsfw ? falSafety(result.data, modelId) : providerFilterSafety(modelId);
    child.info({ latencyMs, safetyVerdict: safety.verdict }, 'image.request.complete');
    return { url, providerId: this.id, modelId, latencyMs, safety };
  }
}

/** A `data:` reference (e.g. a private product photo) is uploaded to fal storage; https references pass through. */
async function toFalUrl(reference: string): Promise<string> {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(reference);
  if (!match) return reference;
  return fal.storage.upload(new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }));
}

/** Map fal's `has_nsfw_concepts[0]` onto the recorded verdict (KAN-33). Missing or not a boolean → indeterminate. */
export function falSafety(data: unknown, model: string): SafetyRecord {
  const flag = (data as { has_nsfw_concepts?: unknown } | undefined)?.has_nsfw_concepts;
  const first = Array.isArray(flag) ? flag[0] : undefined;
  const verdict = first === false ? 'passed' : first === true ? 'rejected' : 'indeterminate';
  return {
    verdict,
    category: verdict === 'rejected' ? 'sexual_content' : null,
    classifier: SAFETY_CLASSIFIER,
    model,
    policyVersion: SAFETY_POLICY_VERSION,
    checkedAt: new Date().toISOString(),
  };
}

/** Gemini (D63): a returned image already passed Google's filter, which refuses unsafe requests with no image. */
export function providerFilterSafety(model: string): SafetyRecord {
  return {
    verdict: 'passed',
    category: null,
    classifier: GEMINI_SAFETY_CLASSIFIER,
    model,
    policyVersion: SAFETY_POLICY_VERSION,
    checkedAt: new Date().toISOString(),
  };
}

const CONTENT_POLICY_PATTERN = /content[ _-]?policy|nsfw|safety[ _-]?(checker|filter|system)/i;
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Map an error thrown by `@fal-ai/client` onto a typed `TaskError`. Uses duck
 * typing (`status`, `body`, `timeoutType`, `code`, `name`) instead of
 * `instanceof ApiError` so it stays robust across client versions. Returns
 * null when the error carries no usable signal.
 */
export function classifyFalError(err: unknown): TaskError | null {
  if (err instanceof TaskError) return err;
  if (typeof err !== 'object' || err === null) return null;
  const e = err as {
    status?: unknown;
    body?: unknown;
    timeoutType?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const message = typeof e.message === 'string' ? e.message : 'fal request failed';
  const wrap = (kind: ConstructorParameters<typeof TaskError>[0]) =>
    new TaskError(kind, message, { cause: err });

  if (typeof e.status === 'number') {
    if (mentionsContentPolicy(e.body) || CONTENT_POLICY_PATTERN.test(message)) {
      return wrap('content_policy');
    }
    if (e.status === 429) return wrap('rate_limited');
    if (e.status === 408 || e.status === 504 || typeof e.timeoutType === 'string') {
      return wrap('timeout');
    }
    if (e.status >= 500) return wrap('provider_unavailable');
    if (e.status >= 400) return wrap('provider_rejected');
    return null;
  }

  if (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'ETIMEDOUT') {
    return wrap('timeout');
  }
  const cause = e.cause as { code?: unknown } | undefined;
  const code = typeof e.code === 'string' ? e.code : typeof cause?.code === 'string' ? cause.code : null;
  if (code && NETWORK_ERROR_CODES.has(code)) return wrap('provider_unavailable');
  if (e.name === 'TypeError' && message === 'fetch failed') return wrap('provider_unavailable');
  return null;
}

/** True when a fal error body names a content-policy rejection (e.g. 422 `content_policy_violation`). */
function mentionsContentPolicy(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') return CONTENT_POLICY_PATTERN.test(detail);
  if (!Array.isArray(detail)) return false;
  return detail.some((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const { type, msg } = item as { type?: unknown; msg?: unknown };
    return (
      (typeof type === 'string' && CONTENT_POLICY_PATTERN.test(type)) ||
      (typeof msg === 'string' && CONTENT_POLICY_PATTERN.test(msg))
    );
  });
}
