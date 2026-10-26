import { describe, expect, it } from 'vitest';
import { assetRoutePath, clientDeliverableUrl } from '../deliverable-url';

describe('clientDeliverableUrl (KAN-52)', () => {
  it('exposes a stored deliverable only as /api/assets/<id>', () => {
    expect(clientDeliverableUrl({ id: 'd-1', contentUrl: 'https://fal.example/x.png', storageKey: 'tenants/t/x.png' }))
      .toBe('/api/assets/d-1');
    expect(assetRoutePath('d-1')).toBe('/api/assets/d-1');
  });

  it.each([null, undefined, ''])('keeps the stored URL of a legacy row (storageKey %s)', (storageKey) => {
    expect(clientDeliverableUrl({ id: 'd-1', contentUrl: 'https://fal.example/x.png', storageKey })).toBe('https://fal.example/x.png');
  });

  it('returns null for an inline deliverable without a key', () => {
    expect(clientDeliverableUrl({ id: 'd-1', contentUrl: null, storageKey: null })).toBeNull();
  });
});
