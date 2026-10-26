'use server';

import { getWorkOS, signOut } from '@workos-inc/authkit-nextjs';
import { cookies } from 'next/headers';
import {
  expireLegacyMfaProof,
  expireMfaPending,
  expireMfaProof,
  MFA_PENDING_COOKIE,
  MFA_PROOF_COOKIE,
  mfaPendingCookieOptions,
  mfaProofCookieOptions,
} from '../../src/auth/platform-mfa';
import {
  mfaProofTtlSeconds,
  requireGlobalAdmin,
  signMfaPending,
  signMfaProof,
  verifyMfaPending,
} from '../../src/auth/resolve-identity';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('auth.actions');
const PENDING_TTL_SECONDS = 5 * 60;

export type PlatformMfaStartResult =
  | { readonly ok: true; readonly mode: 'enroll'; readonly qrCode: string; readonly uri: string }
  | { readonly ok: true; readonly mode: 'challenge' }
  | { readonly ok: false; readonly message: string };

/** Start enrollment or a TOTP challenge for the authenticated global operator. */
export async function beginPlatformMfa(): Promise<PlatformMfaStartResult> {
  try {
    const identity = await requireGlobalAdmin();
    const workos = getWorkOS();
    const existing = await workos.userManagement.listAuthFactors({ userId: identity.workosUserId, limit: 100 });
    const factors = existing.data.filter((factor) => factor.type === 'totp');
    if (factors.length > 0) {
      const challenge = await workos.mfa.challengeFactor({ authenticationFactorId: factors[0].id });
      await setPending(identity, challenge.id, factors[0].id);
      return { ok: true, mode: 'challenge' };
    }
    const enrollment = await workos.userManagement.enrollAuthFactor({
      userId: identity.workosUserId,
      type: 'totp',
      totpIssuer: 'CreaMype',
      totpUser: identity.workosUserId,
    });
    await setPending(identity, enrollment.authenticationChallenge.id, enrollment.authenticationFactor.id);
    return {
      ok: true,
      mode: 'enroll',
      qrCode: enrollment.authenticationFactor.totp.qrCode,
      uri: enrollment.authenticationFactor.totp.uri,
    };
  } catch (error) {
    log.error({ error }, 'platform_mfa.begin_failed');
    return { ok: false, message: 'No pudimos iniciar la verificación. Inténtalo de nuevo.' };
  }
}

/** Verify only the challenge kept in an HttpOnly, session-bound server cookie. */
export async function verifyPlatformMfa(code: string): Promise<{ readonly ok: boolean; readonly message?: string }> {
  try {
    const identity = await requireGlobalAdmin();
    if (!/^\d{6,8}$/.test(code.trim())) return { ok: false, message: 'Escribe el código de autenticación.' };
    const jar = await cookies();
    const pending = jar.get(MFA_PENDING_COOKIE)?.value;
    if (!pending) return { ok: false, message: 'Inicia la verificación de nuevo.' };
    const challenge = verifyMfaPending(pending, identity);
    if (!challenge) {
      expireMfaPending(jar);
      return { ok: false, message: 'Inicia la verificación de nuevo.' };
    }
    const result = await getWorkOS().mfa.verifyChallenge({ authenticationChallengeId: challenge.challengeId, code: code.trim() });
    if (!result.valid || result.challenge.authenticationFactorId !== challenge.factorId) {
      return { ok: false, message: 'El código no es válido. Inténtalo de nuevo.' };
    }
    jar.set(MFA_PROOF_COOKIE, signMfaProof(identity), mfaProofCookieOptions(mfaProofTtlSeconds()));
    expireLegacyMfaProof(jar);
    expireMfaPending(jar);
    return { ok: true };
  } catch (error) {
    log.error({ error }, 'platform_mfa.verify_failed');
    return { ok: false, message: 'No pudimos verificar el código. Inténtalo de nuevo.' };
  }
}

async function setPending(identity: Awaited<ReturnType<typeof requireGlobalAdmin>>, challengeId: string, factorId: string): Promise<void> {
  (await cookies()).set(MFA_PENDING_COOKIE, signMfaPending(identity, challengeId, factorId), mfaPendingCookieOptions(PENDING_TTL_SECONDS));
}

/** End the WorkOS session and drop every platform MFA cookie, including the legacy proof. */
export async function signOutAction() {
  try {
    const jar = await cookies();
    expireMfaProof(jar);
    expireMfaPending(jar);
  } catch (error) {
    // The proof is bound to the WorkOS session, so ending the session still invalidates it.
    log.error({ error }, 'platform_mfa.sign_out_clear_failed');
  }
  await signOut();
}
