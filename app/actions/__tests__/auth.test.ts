import { beforeEach, describe, expect, it, vi } from 'vitest';
// Next's own response cookie store: it keys writes by cookie name, which is the behavior that
// makes setting the new proof and expiring the legacy one in a single response matter (KAN-80).
import { ResponseCookies } from 'next/dist/compiled/@edge-runtime/cookies';

const identity = { workosUserId: 'user_global', sessionId: 'session_1' };

const mocks = vi.hoisted(() => ({
  jar: undefined as unknown,
  requestCookies: new Map<string, string>(),
  verifyChallenge: vi.fn(),
  challengeFactor: vi.fn(),
  listAuthFactors: vi.fn(),
  signOut: vi.fn(),
  verifyMfaPending: vi.fn(),
  order: [] as string[],
}));

vi.mock('next/headers', () => ({ cookies: async () => mocks.jar }));
vi.mock('@workos-inc/authkit-nextjs', () => ({
  getWorkOS: () => ({
    mfa: { verifyChallenge: mocks.verifyChallenge, challengeFactor: mocks.challengeFactor },
    userManagement: { listAuthFactors: mocks.listAuthFactors },
  }),
  signOut: mocks.signOut,
}));
vi.mock('../../../src/auth/resolve-identity', () => ({
  requireGlobalAdmin: async () => identity,
  verifyMfaPending: mocks.verifyMfaPending,
  signMfaProof: () => 'signed-proof',
  signMfaPending: () => 'signed-pending',
  mfaProofTtlSeconds: () => 600,
}));
vi.mock('../../../src/services/logger', () => ({ loggerFor: () => ({ info: vi.fn(), error: vi.fn() }) }));

import { beginPlatformMfa, signOutAction, verifyPlatformMfa } from '../auth';

let headers: Headers;

function setCookieHeaders(): string[] {
  return headers.getSetCookie();
}

function headerFor(name: string, path: string): string | undefined {
  return setCookieHeaders().find((line) => line.startsWith(`${name}=`) && new RegExp(`Path=${path}(;|$)`).test(line));
}

describe('platform MFA cookie actions (KAN-80)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.requestCookies.clear();
    headers = new Headers();
    const responseCookies = new ResponseCookies(headers);
    mocks.jar = {
      get: (name: string) => (mocks.requestCookies.has(name) ? { name, value: mocks.requestCookies.get(name) } : undefined),
      set: (...args: Parameters<ResponseCookies['set']>) => { mocks.order.push('set'); return responseCookies.set(...args); },
      delete: (...args: Parameters<ResponseCookies['delete']>) => { mocks.order.push('delete'); return responseCookies.delete(...args); },
    };
    mocks.signOut.mockImplementation(async () => { mocks.order.push('signOut'); });
  });

  it('sets the proof at / and, in the same response, expires the legacy /platform proof and the pending challenge', async () => {
    mocks.requestCookies.set('cremype_platform_mfa_pending', 'signed-pending');
    mocks.verifyMfaPending.mockReturnValue({ challengeId: 'challenge_1', factorId: 'factor_1' });
    mocks.verifyChallenge.mockResolvedValue({ valid: true, challenge: { authenticationFactorId: 'factor_1' } });

    await expect(verifyPlatformMfa('123456')).resolves.toEqual({ ok: true });

    const proof = headerFor('cremype_platform_mfa_proof', '/');
    expect(proof).toMatch(/^cremype_platform_mfa_proof=signed-proof;/);
    expect(proof).toContain('HttpOnly');
    expect(proof).toContain('SameSite=strict');
    expect(proof).toContain('Max-Age=600');
    expect(headerFor('cremype_platform_mfa', '/platform')).toMatch(/^cremype_platform_mfa=;.*Expires=Thu, 01 Jan 1970/);
    expect(headerFor('cremype_platform_mfa_pending', '/platform')).toMatch(/^cremype_platform_mfa_pending=;.*Expires=Thu, 01 Jan 1970/);
    expect(setCookieHeaders()).toHaveLength(3);
  });

  it('keeps the pending challenge scoped to /platform', async () => {
    mocks.listAuthFactors.mockResolvedValue({ data: [{ id: 'factor_1', type: 'totp' }] });
    mocks.challengeFactor.mockResolvedValue({ id: 'challenge_1' });

    await expect(beginPlatformMfa()).resolves.toEqual({ ok: true, mode: 'challenge' });

    const pending = headerFor('cremype_platform_mfa_pending', '/platform');
    expect(pending).toMatch(/^cremype_platform_mfa_pending=signed-pending;/);
    expect(pending).toContain('Max-Age=300');
    expect(setCookieHeaders()).toHaveLength(1);
  });

  it('expires a forged or stale pending challenge at its own /platform path', async () => {
    mocks.requestCookies.set('cremype_platform_mfa_pending', 'stale');
    mocks.verifyMfaPending.mockReturnValue(undefined);

    await expect(verifyPlatformMfa('123456')).resolves.toMatchObject({ ok: false });
    expect(headerFor('cremype_platform_mfa_pending', '/platform')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(headerFor('cremype_platform_mfa_proof', '/')).toBeUndefined();
  });

  it('sets no proof when the code is wrong', async () => {
    mocks.requestCookies.set('cremype_platform_mfa_pending', 'signed-pending');
    mocks.verifyMfaPending.mockReturnValue({ challengeId: 'challenge_1', factorId: 'factor_1' });
    mocks.verifyChallenge.mockResolvedValue({ valid: false, challenge: { authenticationFactorId: 'factor_1' } });

    await expect(verifyPlatformMfa('123456')).resolves.toMatchObject({ ok: false });
    expect(setCookieHeaders()).toHaveLength(0);
  });

  it('clears the current proof, the legacy /platform proof, and the pending challenge before signing out', async () => {
    await signOutAction();

    expect(headerFor('cremype_platform_mfa_proof', '/')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(headerFor('cremype_platform_mfa', '/platform')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(headerFor('cremype_platform_mfa_pending', '/platform')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(setCookieHeaders()).toHaveLength(3);
    expect(mocks.order.at(-1)).toBe('signOut');
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('still signs out when the cookie store is unavailable', async () => {
    mocks.jar = { delete: () => { throw new Error('cookie store unavailable'); } };
    await signOutAction();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });
});
