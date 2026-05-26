/**
 * Unit tests for ImageGeneratorService. Verifies:
 *   - purpose-specific provider takes precedence over the default
 *   - falls back to the default when no purpose-specific match
 *   - latencyMs surfaces in the result
 *   - providerId in the result matches the routed provider's id
 *   - errors from a provider propagate
 */
import { describe, expect, it, vi } from 'vitest';

import { ImageGeneratorService } from '../generator';
import type { IImageProvider, ImageRequest, ImageResult } from '../types';

function fakeProvider(id: string, urlPrefix: string): IImageProvider {
  return {
    id,
    generate: vi.fn(async (req: ImageRequest): Promise<ImageResult> => ({
      url: `${urlPrefix}/${encodeURIComponent(req.prompt)}`,
      providerId: id,
      modelId: `${id}/test-model`,
      latencyMs: 7,
    })),
  };
}

describe('ImageGeneratorService', () => {
  it('routes a request with a purpose to the registered purpose-specific provider', async () => {
    const def = fakeProvider('default', 'https://default');
    const logoOnly = fakeProvider('logo-vendor', 'https://logo');
    const svc = new ImageGeneratorService(def);
    svc.registerForPurpose('logo', logoOnly);

    const result = await svc.generate({ prompt: 'a logo', purpose: 'logo' });

    expect(logoOnly.generate).toHaveBeenCalledTimes(1);
    expect(def.generate).not.toHaveBeenCalled();
    expect(result.providerId).toBe('logo-vendor');
    expect(result.url).toBe('https://logo/a%20logo');
  });

  it('falls back to the default provider when no purpose-specific match', async () => {
    const def = fakeProvider('default', 'https://default');
    const logoOnly = fakeProvider('logo-vendor', 'https://logo');
    const svc = new ImageGeneratorService(def);
    svc.registerForPurpose('logo', logoOnly);

    const result = await svc.generate({ prompt: 'a banner', purpose: 'social' });

    expect(def.generate).toHaveBeenCalledTimes(1);
    expect(logoOnly.generate).not.toHaveBeenCalled();
    expect(result.providerId).toBe('default');
  });

  it('falls back to the default when the request has no purpose', async () => {
    const def = fakeProvider('default', 'https://default');
    const svc = new ImageGeneratorService(def);
    const result = await svc.generate({ prompt: 'anything' });
    expect(def.generate).toHaveBeenCalledTimes(1);
    expect(result.providerId).toBe('default');
  });

  it('surfaces latencyMs in the result', async () => {
    const def = fakeProvider('default', 'https://default');
    const svc = new ImageGeneratorService(def);
    const result = await svc.generate({ prompt: 'x' });
    expect(result.latencyMs).toBeGreaterThan(0);
  });

  it('propagates provider errors', async () => {
    const failing: IImageProvider = {
      id: 'failing',
      generate: vi.fn(async () => {
        throw new Error('provider boom');
      }),
    };
    const svc = new ImageGeneratorService(failing);
    await expect(svc.generate({ prompt: 'x' })).rejects.toThrow(/provider boom/);
  });
});
