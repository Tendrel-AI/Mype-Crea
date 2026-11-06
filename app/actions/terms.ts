'use server';

/**
 * KAN-27: record the caller's explicit acceptance of the current terms. The client must send
 * `accepted: true` together with the exact version it showed; a stale or missing version, or
 * anything but literal `true`, is rejected. Tenant and user come only from the session.
 */
import { resolveIdentity, type ResolvedIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import { CURRENT_TERMS_VERSION } from '../../src/consent/terms';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('controller.terms');

export type AcceptTermsResult =
  | { readonly ok: true; readonly termsVersion: string; readonly acceptedAt: string }
  | {
      readonly ok: false;
      readonly code: 'invalid_request' | 'terms_outdated' | 'identity_unavailable' | 'accept_failed';
      readonly message: string;
    };

export async function acceptTermsAction(input: {
  readonly termsVersion: string;
  readonly accepted: boolean;
}): Promise<AcceptTermsResult> {
  if (typeof input !== 'object' || input === null || input.accepted !== true) {
    return { ok: false, code: 'invalid_request', message: 'Marca la casilla para confirmar que aceptas los términos.' };
  }
  if (input.termsVersion !== CURRENT_TERMS_VERSION) {
    return { ok: false, code: 'terms_outdated', message: 'Los términos se actualizaron. Recarga la página para revisar la versión vigente.' };
  }
  let identity: ResolvedIdentity;
  try {
    identity = await resolveIdentity();
  } catch {
    return { ok: false, code: 'identity_unavailable', message: 'No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.' };
  }
  try {
    const row = await repos(identity.tenant, identity.user).termsAcceptances.accept(CURRENT_TERMS_VERSION);
    log.info({ tenantId: identity.tenant.id, userId: identity.user.id, termsVersion: row.termsVersion }, 'terms.accepted');
    return { ok: true, termsVersion: row.termsVersion, acceptedAt: row.acceptedAt };
  } catch (error) {
    log.error({ tenantId: identity.tenant.id, userId: identity.user.id, err: error }, 'terms.accept_failed');
    return { ok: false, code: 'accept_failed', message: 'No pudimos registrar tu aceptación. Inténtalo de nuevo.' };
  }
}
