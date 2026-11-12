import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('mypes.storage.brand-dev-fallback')];
  vi.unstubAllEnvs();
});

it('shares one in-memory store across module instances', async () => {
  const a = await import('../brand-upload');
  vi.resetModules();
  const b = await import('../brand-upload');
  expect(b.brandFileStorage).not.toBe(a.brandFileStorage);
  expect(b.brandFileStorage()).toBe(a.brandFileStorage());
});
