/**
 * Unit tests for FalImageProvider. Mocks @fal-ai/client so the test never
 * makes a network call. Verifies endpoint selection (base vs edit), input
 * shape (prompt only vs prompt + image_urls), URL extraction, and the
 * missing-API-key guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { subscribeSpy, configSpy } = vi.hoisted(() => ({
  subscribeSpy: vi.fn(),
  configSpy: vi.fn(),
}));

vi.mock('@fal-ai/client', () => ({
  fal: {
    config: configSpy,
    subscribe: subscribeSpy,
  },
}));

import { FalImageProvider } from '../fal-provider';
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

    const result = await getImageGenerator().generate({ prompt: 'un logo', purpose: 'logo' });

    expect(configSpy).toHaveBeenCalledWith({ credentials: 'test-fal-key' });
    expect(subscribeSpy).toHaveBeenCalledWith('fal-ai/nano-banana-2', {
      input: { prompt: 'un logo' },
    });
    expect(result.providerId).toBe('fal');
    expect(result.url).toBe('https://fal.cdn/independent.png');
  });

  it('throws cleanly when constructed without an API key', () => {
    expect(() => new FalImageProvider('')).toThrow(/FAL_KEY is not set/);
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
    expect(subscribeSpy).toHaveBeenCalledWith('fal-ai/nano-banana-2', {
      input: { prompt: 'una marca minimalista' },
    });
    expect(result.url).toBe('https://fal.cdn/img.png');
    expect(result.providerId).toBe('fal');
    expect(result.modelId).toBe('fal-ai/nano-banana-2');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('uses the edit endpoint when reference URLs are supplied', async () => {
    subscribeSpy.mockResolvedValueOnce({ data: { images: [{ url: 'https://fal.cdn/edited.png' }] } });
    const provider = new FalImageProvider('test-key');

    const result = await provider.generate({
      prompt: 'refine the logo',
      referenceUrls: ['data:image/png;base64,AAAA'],
    });

    expect(subscribeSpy).toHaveBeenCalledWith('fal-ai/nano-banana-2/edit', {
      input: {
        prompt: 'refine the logo',
        image_urls: ['data:image/png;base64,AAAA'],
      },
    });
    expect(result.modelId).toBe('fal-ai/nano-banana-2/edit');
    expect(result.url).toBe('https://fal.cdn/edited.png');
  });

  it('throws when fal returns no image URL', async () => {
    subscribeSpy.mockResolvedValueOnce({ data: { images: [] } });
    const provider = new FalImageProvider('test-key');
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/no image URL/);
  });

  it('propagates errors from fal.subscribe', async () => {
    subscribeSpy.mockRejectedValueOnce(new Error('fal upstream error'));
    const provider = new FalImageProvider('test-key');
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/fal upstream error/);
  });
});
