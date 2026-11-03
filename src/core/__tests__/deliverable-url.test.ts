import { describe, expect, it } from 'vitest';
import { assetRoutePath, clientDeliverableUrl } from '../deliverable-url';

describe('clientDeliverableUrl (KAN-52)', () => {
  it('exposes a stored deliverable only as /api/assets/<id>', () => {
    expect(clientDeliverableUrl({ id: 'd-1', contentUrl: 'https://fal.example/x.png', storageKey: 'tenants/t/x.png', metadata: {} }))
      .toBe('/api/assets/d-1');
    expect(assetRoutePath('d-1')).toBe('/api/assets/d-1');
  });

  it.each([null, undefined, ''])('keeps the stored URL of a legacy row (storageKey %s)', (storageKey) => {
    expect(clientDeliverableUrl({ id: 'd-1', contentUrl: 'https://fal.example/x.png', storageKey, metadata: undefined })).toBe('https://fal.example/x.png');
  });

  it('returns null for an inline deliverable without a key', () => {
    expect(clientDeliverableUrl({ id: 'd-1', contentUrl: null, storageKey: null, metadata: null })).toBeNull();
  });

  // KAN-33: one rule for every client URL — a non-passed or malformed verdict has no URL at all.
  it.each([
    [{ safety: { verdict: 'passed' } }, '/api/assets/d-1'],
    [{ safety: { verdict: 'rejected', category: 'sexual_content' } }, null],
    [{ safety: { verdict: 'indeterminate' } }, null],
    [{ safety: { verdict: 'unknown' } }, null],
    [{ safety: null }, null],
    [{ prompt: 'no safety record (pre-KAN-33 or text)' }, '/api/assets/d-1'],
  ])('applies the recorded safety verdict %j', (metadata, expected) => {
    expect(clientDeliverableUrl({ id: 'd-1', contentUrl: 'https://fal.example/x.png', storageKey: 'k', metadata })).toBe(expected);
    expect(clientDeliverableUrl({ id: 'd-1', contentUrl: 'https://fal.example/x.png', storageKey: null, metadata }))
      .toBe(expected && 'https://fal.example/x.png');
  });
});
