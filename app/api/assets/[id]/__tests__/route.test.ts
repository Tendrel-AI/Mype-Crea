import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  findOwnStorageKey: vi.fn(),
  repos: vi.fn(),
}));

vi.mock('../../../../../src/auth/resolve-identity', () => ({ resolveIdentity: mocks.resolveIdentity }));
vi.mock('@workos-inc/authkit-nextjs', () => ({ withAuth: vi.fn(), getWorkOS: vi.fn() }));
vi.mock('../../../../../src/repos', () => ({
  repos: (...args: unknown[]) => {
    mocks.repos(...args);
    return { deliverables: { findOwnStorageKey: mocks.findOwnStorageKey } };
  },
}));

import { GET } from '../route';
import { InMemoryObjectStorage } from '../../../../../src/services/storage/memory-storage';
import { PRESIGNED_URL_TTL_SECONDS, resetObjectStorage, setObjectStorage } from '../../../../../src/services/storage';

const OWN = '11111111-1111-4111-8111-111111111111';
const KEY = `tenants/tenant-1/conversations/c/tasks/t/0.png`;
const IDENTITY = { tenant: { id: 'tenant-1' }, user: { id: 'user-1' } };

function call(id: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/assets/${id}`), { params: Promise.resolve({ id }) });
}

describe('GET /api/assets/[id] (KAN-52)', () => {
  let storage: InMemoryObjectStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new InMemoryObjectStorage();
    setObjectStorage(storage);
    mocks.resolveIdentity.mockResolvedValue(IDENTITY);
    mocks.findOwnStorageKey.mockImplementation(async (id: string) => (id === OWN ? KEY : null));
  });

  afterEach(() => resetObjectStorage());

  it('redirects the owner to a 15-minute presigned URL with private, no-store', async () => {
    const response = await call(OWN);
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('location')).toBe(`https://bucket.test/${KEY}?X-Amz-Expires=900&X-Amz-Signature=fake`);
    expect(storage.presigned).toEqual([{ key: KEY, ttlSeconds: PRESIGNED_URL_TTL_SECONDS }]);
    expect(mocks.repos).toHaveBeenCalledWith(IDENTITY.tenant, IDENTITY.user);
    expect(mocks.findOwnStorageKey).toHaveBeenCalledWith(OWN);
    expect(await response.text()).toBe('');
  });

  it.each([
    ['another tenant or owner (invisible under RLS/owner filter)', '22222222-2222-4222-8222-222222222222'],
    ['an unknown deliverable', '33333333-3333-4333-8333-333333333333'],
    ['a legacy row without storage key', '44444444-4444-4444-8444-444444444444'],
  ])('answers the same 404 for %s, without presigning', async (_label, id) => {
    const response = await call(id);
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('Not found');
    expect(storage.presigned).toEqual([]);
  });

  it('answers 404 for a malformed id before resolving identity', async () => {
    const response = await call('not-a-uuid');
    expect(response.status).toBe(404);
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
  });

  it('keeps the existing unauthenticated behavior (401, no lookup)', async () => {
    mocks.resolveIdentity.mockRejectedValue(new Error('no session'));
    const response = await call(OWN);
    expect(response.status).toBe(401);
    expect(mocks.findOwnStorageKey).not.toHaveBeenCalled();
  });

  it('answers 503 without a URL when presigning fails or storage is off for a stored row', async () => {
    storage.failPresign = new Error('signing failed');
    expect((await call(OWN)).status).toBe(503);
    setObjectStorage(null);
    const response = await call(OWN);
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
  });
});
