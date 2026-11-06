/**
 * KAN-27 server-side consent gate. Every server entry point that sends a user's business data
 * to an LLM or an agent calls `checkCurrentTerms` after `resolveIdentity()` and before any
 * processing; only `accepted` lets the request through (fail closed). Server-only.
 */
import { resolveIdentity, type ResolvedIdentity } from '../auth/resolve-identity';
import { repos } from '../repos';
import { CURRENT_TERMS_VERSION } from './terms';

export type TermsStatus = 'accepted' | 'required' | 'unavailable';

/** Whether the caller accepted the CURRENT terms version. A lookup failure is `unavailable`. */
export async function checkCurrentTerms(identity: ResolvedIdentity): Promise<TermsStatus> {
  try {
    const accepted = await repos(identity.tenant, identity.user).termsAcceptances.hasAccepted(CURRENT_TERMS_VERSION);
    return accepted ? 'accepted' : 'required';
  } catch {
    return 'unavailable';
  }
}

/** The home page's view of the signed-in caller's consent (identity failures are `unavailable`). */
export async function currentTermsStatus(): Promise<TermsStatus> {
  let identity: ResolvedIdentity;
  try {
    identity = await resolveIdentity();
  } catch {
    return 'unavailable';
  }
  return checkCurrentTerms(identity);
}
