import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import CreaMype from '../components/CreaMype';
import { resolveHomeConversation } from '../src/conversations/selection';
import { AccessRefusedError, requireGlobalAdmin, requireGlobalMfa, resolveIdentity, type ResolvedIdentity } from '../src/auth/resolve-identity';
import { NoAccess } from '../components/crea-mype/NoAccess';
import { TermsConsent } from '../components/crea-mype/TermsConsent';
import { checkCurrentTerms } from '../src/consent/gate';
import { CURRENT_TERMS, TERMS_UNAVAILABLE_MESSAGE } from '../src/consent/terms';

const IDENTITY_UNAVAILABLE_MESSAGE = 'No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.';

export default async function Home({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly conversationId?: string | string[] }>;
}) {
  const { user } = await withAuth();
  if (!user) return null;
  let isGlobalAdmin = false;
  try { await requireGlobalAdmin(); isGlobalAdmin = true; } catch { /* Tenant access is checked by its server actions. */ }
  if (isGlobalAdmin) {
    let hasRecentMfa = false;
    try { await requireGlobalMfa(); hasRecentMfa = true; } catch { /* Route global users through step-up. */ }
    redirect(hasRecentMfa ? '/platform' : '/platform/mfa');
  }

  const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
  // D52: an access refusal gets its own screen; any other failure stays a retryable error.
  let identity: ResolvedIdentity;
  try { identity = await resolveIdentity(); } catch (error) {
    if (error instanceof AccessRefusedError) return <NoAccess email={user.email} reason={error.reason} />;
    return <CreaMype key="identity-unavailable" userEmail={user.email} userName={userName} initialConversationId="" initialError={IDENTITY_UNAVAILABLE_MESSAGE} creationBlocked />;
  }
  const isTenantAdmin = identity.tenantRole === 'admin';
  // KAN-27: the terms come before any conversation; the chat actions enforce it server-side too.
  const terms = await checkCurrentTerms(identity);
  if (terms === 'required') return <TermsConsent terms={CURRENT_TERMS} />;
  if (terms === 'unavailable') {
    return (
      <CreaMype
        key="terms-unavailable"
        userEmail={user.email}
        userName={userName}
        isTenantAdmin={isTenantAdmin}
        initialConversationId=""
        initialError={TERMS_UNAVAILABLE_MESSAGE}
        creationBlocked
      />
    );
  }
  // KAN-25: one server-side decision. No id → most recent conversation (or a new one);
  // an id → that conversation only when the caller owns it, else the same «not found».
  const result = await resolveHomeConversation((await searchParams)?.conversationId);

  switch (result.kind) {
    case 'redirect':
      return redirect(`/?conversationId=${encodeURIComponent(result.conversationId)}`);
    case 'open':
      return (
        <CreaMype
          key={result.history.conversationId}
          userEmail={user.email}
          userName={userName}
        isTenantAdmin={isTenantAdmin}
          initialConversationId={result.history.conversationId}
          initialTurns={result.history.turns}
          initialDeliverables={result.history.deliverables}
          initialBrief={result.history.brief}
          initialStates={result.history.states}
          initialConversations={result.conversations}
          initialBrands={result.brands}
          initialContext={result.history.context}
          initialWelcome={result.history.welcome}
        />
      );
    case 'empty':
      return (
        <CreaMype
          key="no-conversations"
          userEmail={user.email}
          userName={userName}
        isTenantAdmin={isTenantAdmin}
          initialConversationId=""
          initialBrands={result.brands}
        />
      );
    case 'not_found':
      return (
        <CreaMype
          key="conversation-not-found"
          userEmail={user.email}
          userName={userName}
        isTenantAdmin={isTenantAdmin}
          initialConversationId=""
          initialConversations={result.conversations}
          initialBrands={result.brands}
          conversationNotFound
        />
      );
    case 'error':
      return (
        <CreaMype
          key="conversation-error"
          userEmail={user.email}
          userName={userName}
        isTenantAdmin={isTenantAdmin}
          initialConversationId=""
          initialError={result.message}
        />
      );
  }
}
