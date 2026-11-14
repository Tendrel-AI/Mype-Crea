import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRealRoles: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.set, delete: mocks.delete }) }));
vi.mock('../../../src/auth/resolve-identity', () => ({ resolveRealRoles: mocks.resolveRealRoles }));
vi.mock('../../../src/services/logger', () => ({
  loggerFor: () => ({ info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}));

import { resetDevRoleOverrideAction, setDevRoleOverrideAction } from '../dev-roles';

const workosUserId = 'user_dev1';
const realAdmin = { workosUserId, userId: '33333333-3333-4333-8333-333333333333', roles: { tenantRole: 'admin', platformAdmin: true } };
const realMember = { workosUserId, userId: '33333333-3333-4333-8333-333333333333', roles: { tenantRole: 'member', platformAdmin: false } };
const originalDevelopment = process.env.DEVELOPMENT;

describe('developer role switcher actions (KAN-79)', () => {
  beforeEach(() => {
    process.env.DEVELOPMENT = 'TRUE';
    mocks.resolveRealRoles.mockResolvedValue(realAdmin);
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalDevelopment === undefined) delete process.env.DEVELOPMENT;
    else process.env.DEVELOPMENT = originalDevelopment;
  });

  it('rejects every request when DEVELOPMENT is off, without touching identity or cookies', async () => {
    for (const value of [undefined, 'false', '1', 'yes']) {
      if (value === undefined) delete process.env.DEVELOPMENT;
      else process.env.DEVELOPMENT = value;
      await expect(setDevRoleOverrideAction({ tenantRole: 'member' })).resolves.toMatchObject({ ok: false });
      await expect(resetDevRoleOverrideAction()).resolves.toMatchObject({ ok: false });
    }
    expect(mocks.resolveRealRoles).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('stores a downgrade as reductions bound to the user in a strict httpOnly cookie and logs it', async () => {
    await expect(setDevRoleOverrideAction({ tenantRole: 'member', platformAdmin: false })).resolves.toEqual({ ok: true });
    expect(mocks.set).toHaveBeenCalledWith(
      'cremype_dev_role_override',
      'v1.user_dev1.tenant-member+no-platform-admin',
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/' }),
    );
    expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({
      workosUserId,
      real: { tenantRole: 'admin', platformAdmin: true },
      effective: { tenantRole: 'member', platformAdmin: false },
    }), 'auth.role_override.set');
  });

  it('rejects a request to gain a role the user does not really hold, even with the flag on', async () => {
    mocks.resolveRealRoles.mockResolvedValue(realMember);
    await expect(setDevRoleOverrideAction({ tenantRole: 'admin' })).resolves.toEqual({ ok: false, message: 'Solo puedes reducir tus roles, no aumentarlos.' });
    await expect(setDevRoleOverrideAction({ platformAdmin: true })).resolves.toEqual({ ok: false, message: 'Solo puedes reducir tus roles, no aumentarlos.' });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'elevation' }), 'auth.role_override.rejected');
  });

  it.each([
    null,
    'member',
    [],
    { tenantRole: 'owner' },
    { platformAdmin: 'false' },
    { tenantRole: 'member', userId: 'someone-else' },
    { tenantId: 'other-tenant' },
  ])('rejects malformed input %j before resolving identity', async (input) => {
    await expect(setDevRoleOverrideAction(input)).resolves.toEqual({ ok: false, message: 'La selección de roles no es válida.' });
    expect(mocks.resolveRealRoles).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('clears the cookie when asked for the real roles, and on reset', async () => {
    await expect(setDevRoleOverrideAction({ tenantRole: 'admin', platformAdmin: true })).resolves.toEqual({ ok: true });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.delete).toHaveBeenCalledWith({ name: 'cremype_dev_role_override', path: '/' });

    mocks.delete.mockClear();
    await expect(resetDevRoleOverrideAction()).resolves.toEqual({ ok: true });
    expect(mocks.delete).toHaveBeenCalledWith({ name: 'cremype_dev_role_override', path: '/' });
  });

  it('fails closed when the real roles cannot be resolved', async () => {
    mocks.resolveRealRoles.mockRejectedValueOnce(new Error('workos down'));
    await expect(setDevRoleOverrideAction({ tenantRole: 'member' })).resolves.toMatchObject({ ok: false });
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
