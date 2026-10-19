import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import CreaMype from '../components/CreaMype';
import { createConversationAction, loadConversationAction } from './actions/conversations';

export default async function Home({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly conversationId?: string }>;
}) {
  const { user } = await withAuth();
  if (!user) return null;

  const requestedId = (await searchParams)?.conversationId;
  if (requestedId) {
    const history = await loadConversationAction({ conversationId: requestedId });
    if (!history.ok) {
      return (
        <CreaMype
          userEmail={user.email}
          userName={[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
          initialError={history.message}
        />
      );
    }
    return (
      <CreaMype
        userEmail={user.email}
        userName={[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
        initialConversationId={history.conversationId}
        initialTurns={history.turns}
        initialDeliverables={history.deliverables}
      />
    );
  }

  const created = await createConversationAction();
  if (created.ok) {
    redirect(`/?conversationId=${encodeURIComponent(created.conversationId)}`);
  }
  return (
    <CreaMype
      userEmail={user.email}
      userName={[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
      initialConversationId=""
      initialError={created.message}
    />
  );
}
