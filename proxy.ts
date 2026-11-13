import { authkitMiddleware } from '@workos-inc/authkit-nextjs';

// In middleware auth mode, each page is protected by default.
// Exceptions are configured via the `unauthenticatedPaths` option.
//
// `/callback` is the WorkOS OAuth redirect target (app/callback/route.ts in
// App Router resolves to /callback — the `app/` prefix is the directory, not
// part of the URL). It must be unauthenticated, otherwise the middleware
// loops the user back to /login during the OAuth handshake. `/auth/callback`
// serves the same handler for environments whose redirect URI uses that path.
// `/sign-in` (the
// WorkOS Initiate login URI) starts the hosted AuthKit flow and must be reachable
// without a session as well. There is no `/sign-up`: no self registration (D52).
export default authkitMiddleware({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ['/login', '/callback', '/auth/callback', '/sign-in'],
  },
});

// Match every request except Next.js internals, static assets, and the two
// health probes. Matching API routes is required so the middleware refreshes
// the WorkOS session there too — without it, route handlers like
// /api/agents/stream call withAuth({ ensureSignedIn: true }) against an
// unrefreshed cookie and 401.
//
// `/api/health` (liveness) and `/api/health/ready` (readiness) are excluded by
// EXACT path (`$`-anchored), not via `unauthenticatedPaths`: the probes must
// answer without a session and without depending on WorkOS configuration.
// Any other path under /api/health stays protected. Covered by
// app/api/health/__tests__/proxy-matcher.test.ts.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health$|api/health/ready$).*)'],
};