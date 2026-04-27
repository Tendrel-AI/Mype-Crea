import { withAuth } from '@workos-inc/authkit-nextjs';
import CreaMype from '../components/CreaMype';

export default async function Home() {
  const { user } = await withAuth();
  if (!user) return null;

  const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

  return <CreaMype userEmail={user.email} userName={userName} />;
}
