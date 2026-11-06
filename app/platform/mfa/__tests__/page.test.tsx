import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  requireGlobalAdmin: vi.fn(),
  requireGlobalMfa: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../../src/auth/resolve-identity', () => ({
  requireGlobalAdmin: mocks.requireGlobalAdmin,
  requireGlobalMfa: mocks.requireGlobalMfa,
}));
vi.mock('../platform-mfa-form', () => ({ PlatformMfaForm: (props: { next: string }) => props }));

import PlatformMfaPage from '../page';

const page = (next?: string | string[]) => PlatformMfaPage({ searchParams: Promise.resolve(next === undefined ? {} : { next }) });

describe('/platform/mfa next destination (KAN-80)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGlobalAdmin.mockResolvedValue({ workosUserId: 'user_global', sessionId: 'session_1' });
  });

  it('passes a validated next path to the form when no proof exists yet', async () => {
    mocks.requireGlobalMfa.mockRejectedValue(new Error('MFA required'));
    const element = await page('/admin/ai') as ReactElement<{ next: string }>;
    expect(element.props.next).toBe('/admin/ai');
  });

  it.each([undefined, '//evil.com', 'https://x', '/\\evil', ['/admin/ai', '/x']])('falls back to /platform for %j', async (next) => {
    mocks.requireGlobalMfa.mockRejectedValue(new Error('MFA required'));
    const element = await page(next) as ReactElement<{ next: string }>;
    expect(element.props.next).toBe('/platform');
  });

  it('redirects straight to a safe next path when the proof is already valid', async () => {
    mocks.requireGlobalMfa.mockResolvedValue({ workosUserId: 'user_global', sessionId: 'session_1' });
    await expect(page('/admin/ai')).rejects.toThrow('redirect:/admin/ai');
    await expect(page('//evil.com')).rejects.toThrow('redirect:/platform');
  });

  it('sends a non-platform user to /login before reading next', async () => {
    mocks.requireGlobalAdmin.mockRejectedValue(new Error('denied'));
    await expect(page('/admin/ai')).rejects.toThrow('redirect:/login');
    expect(mocks.requireGlobalMfa).not.toHaveBeenCalled();
  });
});
