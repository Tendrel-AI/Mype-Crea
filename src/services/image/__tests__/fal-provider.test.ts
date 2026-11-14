/**
 * Unit tests for FalImageProvider. Mocks @fal-ai/client so the test never
 * makes a network call. Verifies endpoint selection (base vs edit), input
 * shape (prompt only vs prompt + image_urls), URL extraction, and the
 * missing-API-key guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { subscribeSpy, configSpy, uploadSpy, reserveSpy, settleSpy } = vi.hoisted(() => ({
  uploadSpy: vi.fn(),
  subscribeSpy: vi.fn(),
  configSpy: vi.fn(),
  reserveSpy: vi.fn(async () => ({ allowed: true, reservationId: 'reservation-1' })),
  settleSpy: vi.fn(async () => true),
}));

// KAN-43: the production generator charges the task's conversation owner; keep it off the DB.
vi.mock('../../../repos', () => ({
  systemRepos: () => ({ agentTasks: { findById: async () => ({ conversationId: 'conversation-a' }) } }),
  repos: () => ({ usage: { reserve: reserveSpy, settle: settleSpy } }),
}));
vi.mock('../../account-status', () => ({ assertOwnerActive: async () => {} }));
vi.mock('../../../repos/conversations', () => ({ getConversationOwnerUserId: async () => 'owner-a' }));

vi.mock('@fal-ai/client', () => ({
  fal: {
    config: configSpy,
    subscribe: subscribeSpy,
    storage: { upload: uploadSpy },
  },
}));

import { classifyFalError, FalImageProvider, falSafety } from '../fal-provider';
import { TaskError } from '../../../core/task-errors';
import { MAX_REFERENCE_IMAGES } from '../types';
import { getImageGenerator, resetImageGenerator } from '../index';

describe('FalImageProvider', () => {
  beforeEach(() => {
    subscribeSpy.mockReset();
    configSpy.mockReset();
  });

  afterEach(() => {
    resetImageGenerator();
    vi.unstubAllEnvs();
  });

  it.each(['openrouter', 'anthropic'])('keeps fal.ai independent of the %s LLM mode and credentials', async (provider) => {
    vi.stubEnv('LLM_PROVIDER', provider);
    vi.stubEnv('OPENROUTER_API_KEY', undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    vi.stubEnv('FAL_KEY', 'test-fal-key');
    subscribeSpy.mockResolvedValueOnce({
      data: { images: [{ url: 'https://fal.cdn/independent.png' }] },
    });

    const result = await getImageGenerator().generate({ prompt: 'un logo', purpose: 'logo', usage: { tenantId: 'tenant-a', agentTaskId: 'task-a' } });
    expect(reserveSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image', agentTaskId: 'task-a', conversationId: 'conversation-a' }));
    expect(settleSpy).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'reservation-1', outcome: 'succeeded' }));

    expect(configSpy).toHaveBeenCalledWith({ credentials: 'test-fal-key' });
    expect(subscribeSpy).toHaveBeenCalledWith('blackforestlabs/flux-3/klein/text-to-image', {
      input: { prompt: 'un logo', image_size: 'square_hd', enable_safety_checker: true, enable_prompt_expansion: false },
    });
    expect(result.providerId).toBe('fal');
    expect(result.url).toBe('https://fal.cdn/independent.png');
  });

  it('throws cleanly when constructed without an API key', () => {
    expect(() => new FalImageProvider('')).toThrow(/FAL_KEY is not set/);
    expect(() => new FalImageProvider('')).toThrow(expect.objectContaining({ kind: 'config_missing' }));
  });

  it('throws a config_missing TaskError when FAL_KEY is unset', () => {
    vi.stubEnv('FAL_KEY', '');
    expect(() => getImageGenerator()).toThrow(expect.objectContaining({ kind: 'config_missing' }));
  });

  it('calls fal.config with the provided API key', () => {
    new FalImageProvider('test-key');
    expect(configSpy).toHaveBeenCalledWith({ credentials: 'test-key' });
  });

  it('uses the base endpoint when no reference URLs are supplied', async () => {
    subscribeSpy.mockResolvedValueOnce({ data: { images: [{ url: 'https://fal.cdn/img.png' }] } });
    const provider = new FalImageProvider('test-key');

    const result = await provider.generate({ prompt: 'una marca minimalista' });

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith('blackforestlabs/flux-3/klein/text-to-image', {
      input: { prompt: 'una marca minimalista', image_size: 'square_hd', enable_safety_checker: true, enable_prompt_expansion: false },
    });
    expect(result.url).toBe('https://fal.cdn/img.png');
    expect(result.providerId).toBe('fal');
    expect(result.modelId).toBe('blackforestlabs/flux-3/klein/text-to-image');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('uses the edit endpoint when reference URLs are supplied', async () => {
    subscribeSpy.mockResolvedValueOnce({ data: { images: [{ url: 'https://fal.cdn/edited.png' }] } });
    const provider = new FalImageProvider('test-key');

    const result = await provider.generate({
      prompt: 'refine the logo',
      referenceUrls: ['https://example.test/logo.png'],
    });

    expect(subscribeSpy).toHaveBeenCalledWith('blackforestlabs/flux-3/klein/edit-image', {
      input: {
        prompt: 'refine the logo',
        image_size: 'square_hd',
        enable_safety_checker: true,
        enable_prompt_expansion: false,
        image_urls: ['https://example.test/logo.png'],
      },
    });
    expect(result.modelId).toBe('blackforestlabs/flux-3/klein/edit-image');
    expect(result.url).toBe('https://fal.cdn/edited.png');
  });

  it.each([
    ['passed', [false], null],
    ['rejected', [true], 'sexual_content'],
    ['indeterminate', undefined, null],
    ['indeterminate', ['maybe'], null],
    ['indeterminate', [], null],
  ])('records a %s safety verdict with classifier provenance (has_nsfw_concepts=%j, KAN-33)', async (verdict, flags, category) => {
    subscribeSpy.mockResolvedValueOnce({ data: { images: [{ url: 'https://fal.cdn/img.png' }], has_nsfw_concepts: flags } });
    const provider = new FalImageProvider('test-key');

    const result = await provider.generate({ prompt: 'x', referenceUrls: ['https://ref'] });

    expect(result.safety).toEqual({
      verdict,
      category,
      classifier: 'fal-safety-checker',
      model: 'blackforestlabs/flux-3/klein/edit-image',
      policyVersion: 'logo-safety.v1',
      checkedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(result.safety.checkedAt))).toBe(false);
  });

  it('treats a response without data as indeterminate', () => {
    expect(falSafety(undefined, 'blackforestlabs/flux-3/klein/text-to-image').verdict).toBe('indeterminate');
  });

  it('throws when fal returns no image URL', async () => {
    subscribeSpy.mockResolvedValueOnce({ data: { images: [] } });
    const provider = new FalImageProvider('test-key');
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/no image URL/);
  });

  it('propagates untyped errors from fal.subscribe unchanged', async () => {
    const upstream = new Error('fal upstream error');
    subscribeSpy.mockRejectedValueOnce(upstream);
    const provider = new FalImageProvider('test-key');
    await expect(provider.generate({ prompt: 'x' })).rejects.toBe(upstream);
  });

  it('rethrows a fal HTTP error as a typed TaskError', async () => {
    subscribeSpy.mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { status: 429 }));
    const provider = new FalImageProvider('test-key');
    const rejection = provider.generate({ prompt: 'x' });
    await expect(rejection).rejects.toBeInstanceOf(TaskError);
    await expect(rejection).rejects.toMatchObject({ kind: 'rate_limited', message: 'Too Many Requests' });
  });
});

/** Synthetic stand-in for `@fal-ai/client` ApiError (the module is mocked above). */
function apiError(status: number, body?: unknown, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, body, ...extra });
}

describe('classifyFalError', () => {
  it.each([
    ['422 content_policy_violation detail', apiError(422, { detail: [{ type: 'content_policy_violation', msg: 'flagged', loc: ['body'] }] }), 'content_policy'],
    ['400 with an NSFW message in detail', apiError(400, { detail: 'NSFW content detected' }), 'content_policy'],
    ['429', apiError(429), 'rate_limited'],
    ['504', apiError(504), 'timeout'],
    ['408', apiError(408), 'timeout'],
    ['a fal timeoutType', apiError(500, undefined, { timeoutType: 'infrastructure' }), 'timeout'],
    ['500', apiError(500), 'provider_unavailable'],
    ['503', apiError(503), 'provider_unavailable'],
    ['401', apiError(401), 'provider_rejected'],
    ['422 field validation', apiError(422, { detail: [{ type: 'missing', msg: 'Field required', loc: ['body', 'prompt'] }] }), 'provider_rejected'],
    ['a TimeoutError', Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }), 'timeout'],
    ['an ETIMEDOUT code', Object.assign(new Error('socket'), { code: 'ETIMEDOUT' }), 'timeout'],
    ['fetch failed with ECONNRESET cause', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'provider_unavailable'],
  ] as const)('maps %s to %s', (_label, err, kind) => {
    expect(classifyFalError(err)?.kind).toBe(kind);
  });

  it('returns null when the error has no usable signal', () => {
    expect(classifyFalError(new Error('something odd'))).toBeNull();
    expect(classifyFalError('not an error')).toBeNull();
  });
});

describe('FalImageProvider data: references', () => {
  it('uploads a data: reference to fal storage and sends the returned URL; https passes through', async () => {
    uploadSpy.mockResolvedValue('https://fal.media/files/photo.png');
    subscribeSpy.mockResolvedValue({ data: { images: [{ url: 'https://fal.cdn/x.png' }], has_nsfw_concepts: [false] } });
    const provider = new FalImageProvider('k');
    await provider.generate({ prompt: 'p', referenceUrls: ['data:image/png;base64,AQID', 'https://example.test/a.png'] });
    const blob = uploadSpy.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
    expect(subscribeSpy).toHaveBeenCalledWith('blackforestlabs/flux-3/klein/edit-image', {
      input: expect.objectContaining({ image_urls: ['https://fal.media/files/photo.png', 'https://example.test/a.png'] }),
    });
  });

  it('sends at most MAX_REFERENCE_IMAGES references', async () => {
    subscribeSpy.mockResolvedValue({ data: { images: [{ url: 'https://fal.cdn/x.png' }], has_nsfw_concepts: [false] } });
    const refs = Array.from({ length: MAX_REFERENCE_IMAGES + 2 }, (_, i) => `https://example.test/${i}.png`);
    await new FalImageProvider('k').generate({ prompt: 'p', referenceUrls: refs });
    const input = subscribeSpy.mock.calls.at(-1)![1].input as { image_urls: string[] };
    expect(input.image_urls).toEqual(refs.slice(0, MAX_REFERENCE_IMAGES));
  });
});
