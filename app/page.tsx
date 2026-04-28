import { withAuth } from '@workos-inc/authkit-nextjs';
import CreaMype from '../components/CreaMype';
import { resolveIdentity } from '../src/auth/resolve-identity';
import { loggerFor } from '../src/services/logger';

const log = loggerFor('controller.home');

export default async function Home() {
  log.info('home.render.start');
  const { user } = await withAuth();
  if (!user) {
    log.info('home.render.no_user_redirect');
    return null;
  }
  log.info({ workosUserId: user.id, email: user.email }, 'home.render.workos_user');

  // Ensure a `users` row exists for this WorkOS identity before the chat UI
  // mounts. Subsequent chatAction calls reuse the row instead of upserting
  // mid-request. If this throws, surface it to the terminal — Next.js will
  // otherwise show a generic error overlay with no signal of the cause.
  try {
    const identity = await resolveIdentity();
    log.info(
      { tenantId: identity.tenant.id, userId: identity.user.id },
      'home.render.identity_resolved',
    );
  } catch (err) {
    log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'home.render.resolve_identity_failed');
    throw err;
  }

  const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

  return <CreaMype userEmail={user.email} userName={userName} />;
}
