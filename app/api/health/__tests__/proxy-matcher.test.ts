import { describe, expect, it, vi } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';

const authkit = vi.hoisted(() => ({ authkitMiddleware: vi.fn(() => vi.fn()) }));
vi.mock('@workos-inc/authkit-nextjs', () => authkit);

import { config } from '../../../../proxy';

const runsProxy = (url: string) =>
  unstable_doesMiddlewareMatch({ config, url: `https://mype.example${url}` });

describe('proxy.ts matcher and the health probes', () => {
  it.each(['/api/health', '/api/health/ready'])('does not run AuthKit for %s', (path) => {
    expect(runsProxy(path)).toBe(false);
  });

  it.each([
    '/',
    '/login',
    '/admin/ai',
    '/platform',
    '/api/agents/stream?conversationId=x',
    '/api/assets/11111111-1111-4111-8111-111111111111',
    '/api/healthz',
    '/api/health-check',
    '/api/health/readyz',
    '/api/health/ready/extra',
    '/api/health/other',
    '/api/healthy/ready',
    '/foo/api/health',
  ])('still runs AuthKit (protected) for %s', (path) => {
    expect(runsProxy(path)).toBe(true);
  });

  it('keeps the AuthKit allowlist limited to the OAuth flow', () => {
    expect(authkit.authkitMiddleware).toHaveBeenCalledWith({
      middlewareAuth: { enabled: true, unauthenticatedPaths: ['/login', '/callback', '/auth/callback', '/sign-in'] },
    });
  });
});
