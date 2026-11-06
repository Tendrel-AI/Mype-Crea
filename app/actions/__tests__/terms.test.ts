import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const identity = { tenant: { id: 'tenant-1' }, user: { id: 'user-1' } };
  const accept = vi.fn(async (termsVersion: string) => ({
    id: 'acceptance-1', userId: 'user-1', termsVersion, acceptedAt: '2026-11-02T12:00:00.000Z',
  }));
  const repos = vi.fn(() => ({ termsAcceptances: { accept } }));
  const resolveIdentity = vi.fn<() => Promise<unknown>>(async () => identity);
  return { identity, accept, repos, resolveIdentity };
});

vi.mock('../../../src/auth/resolve-identity', () => ({ resolveIdentity: mocks.resolveIdentity }));
vi.mock('../../../src/repos', () => ({ repos: mocks.repos }));
vi.mock('../../../src/services/logger', () => ({ loggerFor: () => ({ info: vi.fn(), error: vi.fn() }) }));

import { acceptTermsAction } from '../terms';
import { CURRENT_TERMS_VERSION } from '../../../src/consent/terms';

describe('acceptTermsAction (KAN-27)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the explicit acceptance of the current version for the session identity only', async () => {
    const forged = { termsVersion: CURRENT_TERMS_VERSION, accepted: true, tenantId: 'tenant-2', userId: 'user-2', acceptedAt: '2000-01-01' };
    const result = await acceptTermsAction(forged as never);
    expect(result).toEqual({ ok: true, termsVersion: CURRENT_TERMS_VERSION, acceptedAt: '2026-11-02T12:00:00.000Z' });
    expect(mocks.repos).toHaveBeenCalledWith(mocks.identity.tenant, mocks.identity.user);
    expect(mocks.accept).toHaveBeenCalledWith(CURRENT_TERMS_VERSION);
  });

  it.each([
    ['no accepted flag', { termsVersion: CURRENT_TERMS_VERSION }],
    ['accepted false', { termsVersion: CURRENT_TERMS_VERSION, accepted: false }],
    ['accepted as a string', { termsVersion: CURRENT_TERMS_VERSION, accepted: 'true' }],
    ['null input', null],
  ])('rejects %s without identity or writes', async (_name, input) => {
    const result = await acceptTermsAction(input as never);
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it.each([['terminos-v0'], [''], [undefined]])('rejects a stale or missing version %s', async (termsVersion) => {
    const result = await acceptTermsAction({ termsVersion, accepted: true } as never);
    expect(result).toMatchObject({ ok: false, code: 'terms_outdated' });
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('fails safely without a session or when the write fails', async () => {
    mocks.resolveIdentity.mockRejectedValueOnce(new Error('no session'));
    expect(await acceptTermsAction({ termsVersion: CURRENT_TERMS_VERSION, accepted: true }))
      .toMatchObject({ ok: false, code: 'identity_unavailable' });
    expect(mocks.accept).not.toHaveBeenCalled();

    mocks.accept.mockRejectedValueOnce(new Error('db down'));
    expect(await acceptTermsAction({ termsVersion: CURRENT_TERMS_VERSION, accepted: true }))
      .toMatchObject({ ok: false, code: 'accept_failed', message: 'No pudimos registrar tu aceptación. Inténtalo de nuevo.' });
  });
});
