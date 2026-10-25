/**
 * fal.ai-backed IImageProvider.
 *
 * The only place in the codebase that imports `@fal-ai/client`. Picks
 * `nano-banana-2/edit` when reference images are provided, `nano-banana-2`
 * otherwise. Logs request lifecycle under scope `service.image.fal`.
 *
 * Failures are rethrown as `TaskError` with a typed kind whenever the fal
 * error carries a usable signal (HTTP status, content-policy detail, timeout,
 * network failure), so the task's `error_category` is classified correctly
 * (architecture §2.5). Errors without such a signal are rethrown unchanged.
 */
import { fal } from '@fal-ai/client';
import { TaskError } from '../../core/task-errors';
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
      throw new TaskError(
        'config_missing',
        'FAL_KEY is not set. The fal image provider requires a fal.ai API key.',
      );
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
    child.info({ latencyMs }, 'image.request.complete');
    return { url, providerId: this.id, modelId, latencyMs };
  }
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
