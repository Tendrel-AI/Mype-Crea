import { getSignInUrl } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';

// Initiate login URI for the WorkOS dashboard (origin + /sign-in). getSignInUrl()
// sets the PKCE verifier cookie, so it must run in a route handler, not a page render.
export async function GET() {
  return redirect(await getSignInUrl());
}
