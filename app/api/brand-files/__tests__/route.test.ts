import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryObjectStorage } from '../../../../src/services/storage/memory-storage';
import { setObjectStorage } from '../../../../src/services/storage';

const BRAND = '99999999-9999-4999-8999-999999999999';
const PRODUCT = '88888888-8888-4888-8888-888888888888';
const FILE_ID = '77777777-7777-4777-8777-777777777777';

const mocks = vi.hoisted(() => ({
  identity: { tenant: { id: 'tenant-1' }, user: { id: 'user-1' } },
  resolveIdentity: vi.fn(),
  brandGet: vi.fn(),
  productGet: vi.fn(),
  add: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../../../src/auth/resolve-identity', () => ({ resolveIdentity: mocks.resolveIdentity }));
vi.mock('../../../../src/conversations/selection', () => ({
  isConversationId: (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v),
}));
vi.mock('../../../../src/repos', () => ({
  repos: () => ({
    brands: { get: mocks.brandGet },
    products: { get: mocks.productGet },
    brandFiles: { add: mocks.add, get: mocks.get },
  }),
}));

import { POST } from '../route';
import { GET } from '../[id]/route';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const svg = (body: string) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);

/** A multipart request with a real content-length, like a browser sends. */
async function upload(fields: Record<string, string>, file?: { bytes: Uint8Array; name?: string }, overrideLength?: number): Promise<Request> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set('file', new File([file.bytes as BlobPart], file.name ?? 'logo.png', { type: 'image/png' }));
  const raw = new Request('http://app.test/api/brand-files', { method: 'POST', body: form });
  const body = await raw.arrayBuffer();
  return new Request('http://app.test/api/brand-files', {
    method: 'POST', body,
    headers: { 'content-type': raw.headers.get('content-type')!, 'content-length': String(overrideLength ?? body.byteLength) },
  });
}

let storage: InMemoryObjectStorage;

describe('POST /api/brand-files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage = new InMemoryObjectStorage();
    setObjectStorage(storage);
    mocks.resolveIdentity.mockResolvedValue(mocks.identity);
    mocks.brandGet.mockResolvedValue({ id: BRAND });
    mocks.productGet.mockResolvedValue({ id: PRODUCT, brandId: BRAND });
    mocks.add.mockImplementation(async (file: { id: string; originalName: string }) => ({ ok: true, file: { ...file } }));
  });

  it('stores a PNG logo: object first, then the row, with a server-chosen type and key', async () => {
    const res = await POST((await upload({ brandId: BRAND, kind: 'logo' }, { bytes: PNG })) as never);
    expect(res.status).toBe(201);
    const row = mocks.add.mock.calls[0][0];
    expect(row).toMatchObject({ brandId: BRAND, kind: 'logo', contentType: 'image/png', byteSize: PNG.length });
    expect(row.storageKey).toMatch(/^tenants\/tenant-1\/brands\/99999999-.*\.png$/);
    expect(storage.objects.has(row.storageKey)).toBe(true);
  });

  it('refuses an oversized upload from content-length before reading it', async () => {
    const res = await POST((await upload({ brandId: BRAND, kind: 'asset' }, { bytes: PNG }, 6 * 1024 * 1024)) as never);
    expect(res.status).toBe(413);
    expect(mocks.add).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
  });

  it('refuses real bytes over 5 MB even when content-length lies', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG);
    const res = await POST((await upload({ brandId: BRAND, kind: 'asset' }, { bytes: big }, 1000)) as never);
    expect(res.status).toBe(413);
    expect(storage.objects.size).toBe(0);
  });

  it('decides the type by magic bytes, not by name or client MIME', async () => {
    const res = await POST((await upload({ brandId: BRAND, kind: 'asset' }, { bytes: new TextEncoder().encode('MZ not an image'), name: 'logo.png' })) as never);
    expect(res.status).toBe(415);
    expect(storage.objects.size).toBe(0);
  });

  it.each([
    ['a script tag', '<script>alert(1)</script>'],
    ['an onload handler', '<rect onload="x()"/>'],
    ['javascript: links', '<a href="javascript:alert(1)"><rect/></a>'],
    ['foreignObject', '<foreignObject><div/></foreignObject>'],
    ['an external href', '<image href="https://evil.test/x.png"/>'],
  ])('refuses an SVG with %s', async (_label, body) => {
    const res = await POST((await upload({ brandId: BRAND, kind: 'asset' }, { bytes: svg(body), name: 'a.svg' })) as never);
    expect(res.status).toBe(415);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('accepts an inert SVG', async () => {
    const res = await POST((await upload({ brandId: BRAND, kind: 'asset' }, { bytes: svg('<rect width="1" height="1"/><use href="#a"/>'), name: 'a.svg' })) as never);
    expect(res.status).toBe(201);
    expect(mocks.add.mock.calls[0][0].contentType).toBe('image/svg+xml');
  });

  it('the 6th asset is refused and its object is deleted (no orphan)', async () => {
    mocks.add.mockResolvedValueOnce({ ok: false, code: 'asset_limit_reached', limit: 5 });
    const res = await POST((await upload({ brandId: BRAND, kind: 'asset' }, { bytes: PNG })) as never);
    expect(res.status).toBe(409);
    expect(storage.objects.size).toBe(0);
  });

  it('a failing row insert deletes the object and answers 503', async () => {
    mocks.add.mockRejectedValueOnce(new Error('db down'));
    const res = await POST((await upload({ brandId: BRAND, kind: 'asset' }, { bytes: PNG })) as never);
    expect(res.status).toBe(503);
    expect(storage.objects.size).toBe(0);
  });

  it('a foreign, missing or malformed brand (or a product of another brand) is the same 404 and stores nothing', async () => {
    mocks.brandGet.mockResolvedValueOnce(null);
    const foreign = await POST((await upload({ brandId: BRAND, kind: 'asset' }, { bytes: PNG })) as never);
    const malformed = await POST((await upload({ brandId: 'nope', kind: 'asset' }, { bytes: PNG })) as never);
    mocks.productGet.mockResolvedValueOnce({ id: PRODUCT, brandId: '11111111-1111-4111-8111-111111111111' });
    const otherBrandProduct = await POST((await upload({ brandId: BRAND, productId: PRODUCT, kind: 'asset' }, { bytes: PNG })) as never);
    expect([foreign.status, malformed.status, otherBrandProduct.status]).toEqual([404, 404, 404]);
    expect(await foreign.json()).toEqual(await malformed.json());
    expect(storage.objects.size).toBe(0);
  });

  it('replacing the logo deletes the previous object', async () => {
    storage.objects.set('old-key', { bytes: PNG, contentType: 'image/png' });
    mocks.add.mockImplementationOnce(async (file: { id: string }) => ({ ok: true, file, replacedStorageKey: 'old-key' }));
    const res = await POST((await upload({ brandId: BRAND, kind: 'logo' }, { bytes: PNG })) as never);
    expect(res.status).toBe(201);
    expect(storage.objects.has('old-key')).toBe(false);
    expect(storage.objects.size).toBe(1);
  });

  it('a logo cannot belong to a product, and an anonymous caller gets 401', async () => {
    expect((await POST((await upload({ brandId: BRAND, productId: PRODUCT, kind: 'logo' }, { bytes: PNG })) as never)).status).toBe(400);
    mocks.resolveIdentity.mockRejectedValueOnce(new Error('no session'));
    expect((await POST((await upload({ brandId: BRAND, kind: 'logo' }, { bytes: PNG })) as never)).status).toBe(401);
  });
});

describe('GET /api/brand-files/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage = new InMemoryObjectStorage();
    setObjectStorage(storage);
    mocks.resolveIdentity.mockResolvedValue(mocks.identity);
  });
  const call = (id: string) => GET(new Request('http://app.test') as never, { params: Promise.resolve({ id }) });

  it("another user's (or a missing/malformed) file is the same 404", async () => {
    mocks.get.mockResolvedValue(null);
    const foreign = await call(FILE_ID);
    const malformed = await call('nope');
    expect([foreign.status, malformed.status]).toEqual([404, 404]);
    expect(await foreign.text()).toBe(await malformed.text());
  });

  it('serves an SVG with the inert headers (CSP sandbox, nosniff, inline) and the stored type', async () => {
    storage.objects.set('k', { bytes: svg('<rect/>'), contentType: 'image/svg+xml' });
    mocks.get.mockResolvedValue({ id: FILE_ID, storageKey: 'k', contentType: 'image/svg+xml' });
    const res = await call(FILE_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe('inline');
  });

  it('answers 404 when the row exists but the object is gone', async () => {
    mocks.get.mockResolvedValue({ id: FILE_ID, storageKey: 'gone', contentType: 'image/png' });
    expect((await call(FILE_ID)).status).toBe(404);
  });
});

