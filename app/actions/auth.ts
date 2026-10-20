'use server';

import { getWorkOS, signOut } from '@workos-inc/authkit-nextjs';
import { cookies } from 'next/headers';
import {
  mfaProofCookieName,
  mfaProofTtlSeconds,
  requireGlobalAdmin,
  signMfaPending,
  signMfaProof,
  verifyMfaPending,
} from '../../src/auth/resolve-identity';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('auth.actions');
const pendingCookie = 'cremype_platform_mfa_pending';

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
    const pending = jar.get(pendingCookie)?.value;
    if (!pending) return { ok: false, message: 'Inicia la verificación de nuevo.' };
    const challenge = verifyMfaPending(pending, identity);
    if (!challenge) {
      jar.delete(pendingCookie);
      return { ok: false, message: 'Inicia la verificación de nuevo.' };
    }
    const result = await getWorkOS().mfa.verifyChallenge({ authenticationChallengeId: challenge.challengeId, code: code.trim() });
    if (!result.valid || result.challenge.authenticationFactorId !== challenge.factorId) {
      return { ok: false, message: 'El código no es válido. Inténtalo de nuevo.' };
    }
    jar.set(mfaProofCookieName(), signMfaProof(identity), cookieOptions(mfaProofTtlSeconds()));
    jar.delete(pendingCookie);
    return { ok: true };
  } catch (error) {
    log.error({ error }, 'platform_mfa.verify_failed');
    return { ok: false, message: 'No pudimos verificar el código. Inténtalo de nuevo.' };
  }
}

async function setPending(identity: Awaited<ReturnType<typeof requireGlobalAdmin>>, challengeId: string, factorId: string): Promise<void> {
  (await cookies()).set(pendingCookie, signMfaPending(identity, challengeId, factorId), cookieOptions(5 * 60));
}

function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/platform', maxAge };
}

export async function signOutAction() {
  await signOut();
}
