import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expireLegacyMfaProof,
  expireMfaPending,
  expireMfaProof,
  LEGACY_MFA_PROOF_COOKIE,
  MFA_PENDING_COOKIE,
  MFA_PROOF_COOKIE,
  mfaPendingCookieOptions,
  mfaProofCookieOptions,
  MfaRequiredError,
} from '../platform-mfa';

describe('platform MFA cookies (KAN-80)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('scopes the proof to / so /admin/ai receives it, and keeps the pending challenge under /platform', () => {
    expect(mfaProofCookieOptions(600)).toEqual({ httpOnly: true, secure: false, sameSite: 'strict', path: '/', maxAge: 600 });
    expect(mfaPendingCookieOptions(300)).toEqual({ httpOnly: true, secure: false, sameSite: 'strict', path: '/platform', maxAge: 300 });
  });

  it('marks both cookies secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(mfaProofCookieOptions(600)).toMatchObject({ secure: true, path: '/' });
    expect(mfaPendingCookieOptions(300)).toMatchObject({ secure: true, path: '/platform' });
  });

  it('uses a proof name distinct from the legacy /platform proof, so both can be written in one response', () => {
    expect(new Set([MFA_PROOF_COOKIE, LEGACY_MFA_PROOF_COOKIE, MFA_PENDING_COOKIE]).size).toBe(3);
    expect(LEGACY_MFA_PROOF_COOKIE).toBe('cremype_platform_mfa');
  });

  it('expires each cookie at the path it was set on', () => {
    const jar = { delete: vi.fn() };
    expireMfaProof(jar);
    expireMfaPending(jar);
    expireLegacyMfaProof(jar);
    const deleted = jar.delete.mock.calls.map(([options]) => [options.name, options.path]);
    expect(deleted).toEqual([
      [MFA_PROOF_COOKIE, '/'],
      [LEGACY_MFA_PROOF_COOKIE, '/platform'],
      [MFA_PENDING_COOKIE, '/platform'],
      [LEGACY_MFA_PROOF_COOKIE, '/platform'],
    ]);
    for (const [options] of jar.delete.mock.calls) expect(options).toMatchObject({ httpOnly: true, sameSite: 'strict' });
  });

  it('exposes a typed mfa_required reason with neutral Spanish copy', () => {
    const error = new MfaRequiredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe('mfa_required');
    expect(error.message).toBe('Verifica tu código de autenticación para continuar.');
  });
});
