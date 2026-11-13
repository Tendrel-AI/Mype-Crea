import { getSignUpUrl } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';

// getSignUpUrl() sets the PKCE verifier cookie, so it must run in a route handler.
export async function GET() {
  return redirect(await getSignUpUrl());
}
