import { authkitMiddleware } from '@workos-inc/authkit-nextjs';

// In middleware auth mode, each page is protected by default.
// Exceptions are configured via the `unauthenticatedPaths` option.
//
// `/callback` is the WorkOS OAuth redirect target (app/callback/route.ts in
// App Router resolves to /callback — the `app/` prefix is the directory, not
// part of the URL). It must be unauthenticated, otherwise the middleware
// loops the user back to /login during the OAuth handshake.
export default authkitMiddleware({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ['/login', '/callback'],
  },
});

// Match every request except Next.js internals and static assets. This is
// required so the middleware refreshes the WorkOS session on API routes too —
// without it, route handlers like /api/agents/stream call
// withAuth({ ensureSignedIn: true }) against an unrefreshed cookie and 401.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};