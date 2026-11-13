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
import { TaskError } from '../../../core/task-errors';
import type { UsageLedger } from '../../usage/gateway';
import { IMAGE_PRICE_USD, usageLimitMessage } from '../../usage/policy';

function fakeProvider(id: string, urlPrefix: string): IImageProvider {
  return {
    id,
    generate: vi.fn(async (req: ImageRequest): Promise<ImageResult> => ({
      url: `${urlPrefix}/${encodeURIComponent(req.prompt)}`,
      providerId: id,
      modelId: `${id}/test-model`,
      latencyMs: 7,
      safety: { verdict: 'passed', category: null, classifier: 'fake', model: `${id}/test-model`, policyVersion: 'test', checkedAt: '2026-11-03T00:00:00.000Z' },
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

  describe('usage gate (KAN-43)', () => {
    const scope = { tenantId: 'tenant-a', agentTaskId: 'task-a' };
    function gate(denied?: 'user_image_daily') {
      const events: Array<Record<string, unknown>> = [];
      const ledger: UsageLedger = {
        reserve: vi.fn(async (request) => {
          events.push({ op: 'reserve', ...request });
          return denied
            ? { allowed: false as const, reason: denied, reservationId: 'denied-1' }
            : { allowed: true as const, reservationId: 'reservation-1' };
        }),
        settle: vi.fn(async (settlement) => {
          events.push({ op: 'settle', ...settlement });
          return true;
        }),
      };
      const resolver = vi.fn(async () => ({ ledger, conversationId: 'conversation-a' }));
      return { events, ledger, resolver };
    }

    it('allowed: reserves the image price, calls the provider once, settles the real cost', async () => {
      const def = fakeProvider('fal', 'https://fal');
      const { events, resolver } = gate();
      const svc = new ImageGeneratorService(def, resolver);
      await svc.generate({ prompt: 'logo', purpose: 'logo', usage: scope });
      expect(resolver).toHaveBeenCalledWith(scope);
      expect(def.generate).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        { op: 'reserve', kind: 'image', estimatedCostUsd: IMAGE_PRICE_USD, provider: 'fal', conversationId: 'conversation-a', agentTaskId: 'task-a' },
        { op: 'settle', reservationId: 'reservation-1', actualCostUsd: IMAGE_PRICE_USD, outcome: 'succeeded', costSource: 'flat' },
      ]);
    });

    it('denied: the provider is never called and the task fails as usage_limited with Spanish copy', async () => {
      const def = fakeProvider('fal', 'https://fal');
      const { ledger, resolver } = gate('user_image_daily');
      const svc = new ImageGeneratorService(def, resolver);
      const error = await svc.generate({ prompt: 'logo', usage: scope }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(TaskError);
      expect(error).toMatchObject({ kind: 'usage_limited', message: usageLimitMessage('user_image_daily') });
      expect(def.generate).not.toHaveBeenCalled();
      expect(ledger.settle).not.toHaveBeenCalled();
    });

    it('failure: a typed rejection settles at 0, a timeout keeps the price (may have been billed)', async () => {
      for (const [kind, cost] of [['provider_rejected', 0], ['timeout', IMAGE_PRICE_USD]] as const) {
        const failing: IImageProvider = { id: 'fal', generate: vi.fn(async () => { throw new TaskError(kind, 'boom'); }) };
        const { events, resolver } = gate();
        const svc = new ImageGeneratorService(failing, resolver);
        await expect(svc.generate({ prompt: 'x', usage: scope })).rejects.toMatchObject({ kind });
        expect(events[1]).toEqual({ op: 'settle', reservationId: 'reservation-1', actualCostUsd: cost, outcome: 'failed', costSource: 'estimate' });
      }
    });

    it('fails closed: a gated generator refuses a request without a usage scope', async () => {
      const def = fakeProvider('fal', 'https://fal');
      const svc = new ImageGeneratorService(def, gate().resolver);
      await expect(svc.generate({ prompt: 'x' })).rejects.toMatchObject({ kind: 'config_missing' });
      expect(def.generate).not.toHaveBeenCalled();
    });
  });
});
