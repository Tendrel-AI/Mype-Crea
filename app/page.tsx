import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import CreaMype from '../components/CreaMype';
import { resolveHomeConversation } from '../src/conversations/selection';
import { requireGlobalAdmin, requireGlobalMfa } from '../src/auth/resolve-identity';
import { TermsConsent } from '../components/crea-mype/TermsConsent';
import { currentTermsStatus } from '../src/consent/gate';
import { CURRENT_TERMS, TERMS_UNAVAILABLE_MESSAGE } from '../src/consent/terms';

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
  // KAN-27: the terms come before any conversation; the chat actions enforce it server-side too.
  const terms = await currentTermsStatus();
  if (terms === 'required') return <TermsConsent terms={CURRENT_TERMS} />;
  if (terms === 'unavailable') {
    return (
      <CreaMype
        key="terms-unavailable"
        userEmail={user.email}
        userName={userName}
        initialConversationId=""
        initialError={TERMS_UNAVAILABLE_MESSAGE}
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
          initialConversationId={result.history.conversationId}
          initialTurns={result.history.turns}
          initialDeliverables={result.history.deliverables}
          initialBrief={result.history.brief}
          initialConversations={result.conversations}
        />
      );
    case 'not_found':
      return (
        <CreaMype
          key="conversation-not-found"
          userEmail={user.email}
          userName={userName}
          initialConversationId=""
          initialConversations={result.conversations}
          conversationNotFound
        />
      );
    case 'error':
      return (
        <CreaMype
          key="conversation-error"
          userEmail={user.email}
          userName={userName}
          initialConversationId=""
          initialError={result.message}
        />
      );
  }
}
