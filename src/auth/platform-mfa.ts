/**
 * Platform MFA cookies and the typed step-up failure (KAN-80). Pure: no Next.js imports, so the
 * names, paths, and options have one definition shared by the actions, the resolver, and tests.
 *
 * The proof cookie is scoped to `/` because the step-up is also required outside `/platform`
 * (for example `/admin/ai`, which serves tenant admins too). The pending challenge cookie is only
 * used by `/platform/mfa`, so it stays scoped to `/platform`.
 *
 * The proof cookie has a new name. The proof used to be `cremype_platform_mfa` scoped to
 * `/platform`, and Next keys response cookies by name: setting the new proof and expiring the old
 * one under the same name in one response would keep only the last write. A distinct name lets
 * every response that sets or clears the proof also expire the legacy cookie, and the legacy
 * cookie is never read, so it can neither shadow nor duplicate the current proof.
 */

export const MFA_PROOF_COOKIE = 'cremype_platform_mfa_proof';
export const MFA_PENDING_COOKIE = 'cremype_platform_mfa_pending';
/** Pre-KAN-80 proof cookie. Only ever expired, never read. */
export const LEGACY_MFA_PROOF_COOKIE = 'cremype_platform_mfa';

export const MFA_PROOF_COOKIE_PATH = '/';
export const MFA_PENDING_COOKIE_PATH = '/platform';
export const LEGACY_MFA_PROOF_COOKIE_PATH = '/platform';

export interface MfaCookieAttributes {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'strict';
  readonly path: string;
}

export interface MfaCookieOptions extends MfaCookieAttributes {
  readonly maxAge: number;
}

/** The subset of Next's mutable cookie store these helpers need. */
export interface MfaCookieWriter {
  delete(options: MfaCookieAttributes & { readonly name: string }): unknown;
}

function attributes(path: string): MfaCookieAttributes {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path };
}

export function mfaProofCookieOptions(maxAge: number): MfaCookieOptions {
  return { ...attributes(MFA_PROOF_COOKIE_PATH), maxAge };
}

export function mfaPendingCookieOptions(maxAge: number): MfaCookieOptions {
  return { ...attributes(MFA_PENDING_COOKIE_PATH), maxAge };
}

/** Expire the pre-KAN-80 proof. Call it in every response that sets or clears the proof. */
export function expireLegacyMfaProof(jar: MfaCookieWriter): void {
  jar.delete({ name: LEGACY_MFA_PROOF_COOKIE, ...attributes(LEGACY_MFA_PROOF_COOKIE_PATH) });
}

/** Expire the current proof and the legacy one. */
export function expireMfaProof(jar: MfaCookieWriter): void {
  jar.delete({ name: MFA_PROOF_COOKIE, ...attributes(MFA_PROOF_COOKIE_PATH) });
  expireLegacyMfaProof(jar);
}

/** Expire the pending challenge. A delete without its `/platform` path would not match it. */
export function expireMfaPending(jar: MfaCookieWriter): void {
  jar.delete({ name: MFA_PENDING_COOKIE, ...attributes(MFA_PENDING_COOKIE_PATH) });
}

/** Thrown when an account that requires platform step-up has no valid proof for this session. */
export class MfaRequiredError extends Error {
  readonly reason = 'mfa_required' as const;

  constructor() {
    super('Verifica tu código de autenticación para continuar.');
    this.name = 'MfaRequiredError';
  }
}
