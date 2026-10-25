import { describe, expect, it } from 'vitest';
import {
  applyRoleReductions,
  parseRoleOverrideCookie,
  planRoleOverride,
  roleOverrideCookieName,
  roleOverrideCookieOptions,
  serializeRoleOverride,
  type RoleReductions,
  type RoleSet,
} from '../role-override';

const uid = 'user_01ABC';
const allRoleSets: RoleSet[] = [
  { tenantRole: 'admin', platformAdmin: true },
  { tenantRole: 'admin', platformAdmin: false },
  { tenantRole: 'member', platformAdmin: true },
  { tenantRole: 'member', platformAdmin: false },
];
const allReductions: RoleReductions[] = [
  { dropTenantAdmin: false, dropPlatformAdmin: false },
  { dropTenantAdmin: true, dropPlatformAdmin: false },
  { dropTenantAdmin: false, dropPlatformAdmin: true },
  { dropTenantAdmin: true, dropPlatformAdmin: true },
];

describe('role override rules (KAN-79)', () => {
  it('never yields a role the real identity does not hold, for every combination', () => {
    for (const real of allRoleSets) {
      for (const reductions of allReductions) {
        const effective = applyRoleReductions(real, reductions);
        if (effective.tenantRole === 'admin') expect(real.tenantRole).toBe('admin');
        if (effective.platformAdmin) expect(real.platformAdmin).toBe(true);
      }
    }
  });

  it('round-trips every non-empty reduction through the cookie format, bound to the user', () => {
    for (const reductions of allReductions.slice(1)) {
      const value = serializeRoleOverride(uid, reductions);
      expect(value).toMatch(/^v1\.user_01ABC\./);
      expect(parseRoleOverrideCookie(value, uid)).toEqual(reductions);
      expect(parseRoleOverrideCookie(value, 'user_other')).toBeUndefined();
    }
    expect(serializeRoleOverride(uid, { dropTenantAdmin: true, dropPlatformAdmin: true })).toBe('v1.user_01ABC.tenant-member+no-platform-admin');
    expect(() => serializeRoleOverride(uid, allReductions[0])).toThrow();
    expect(() => serializeRoleOverride('not-a-user', allReductions[1])).toThrow();
  });

  it.each([
    undefined,
    '',
    'v1',
    `v1.${uid}`,
    `v1.${uid}.`,
    `v1.${uid}.tenant-admin`,
    `v1.${uid}.tenant-member+`,
    `v1.${uid}.no-platform-admin+tenant-member`,
    `v1.${uid}.tenant-member+tenant-member`,
    `v1.${uid}.tenant-member.extra`,
    `V1.${uid}.tenant-member`,
    ` v1.${uid}.tenant-member`,
    `v1.${uid}.tenant-member${'x'.repeat(200)}`,
    '{"tenantRole":"member"}',
  ])('ignores malformed cookie %j', (raw) => {
    expect(parseRoleOverrideCookie(raw, uid)).toBeUndefined();
  });

  it('rejects elevation and tenant requests without a tenant, and plans only real reductions', () => {
    expect(planRoleOverride({ tenantRole: 'member', platformAdmin: false }, { tenantRole: 'admin' })).toEqual({ ok: false, reason: 'elevation' });
    expect(planRoleOverride({ tenantRole: 'admin', platformAdmin: false }, { platformAdmin: true })).toEqual({ ok: false, reason: 'elevation' });
    expect(planRoleOverride({ tenantRole: null, platformAdmin: false }, { tenantRole: 'admin' })).toEqual({ ok: false, reason: 'elevation' });
    expect(planRoleOverride({ tenantRole: null, platformAdmin: true }, { tenantRole: 'member' })).toEqual({ ok: false, reason: 'invalid' });
    expect(planRoleOverride({ tenantRole: 'admin', platformAdmin: true }, { tenantRole: 'owner' as never })).toEqual({ ok: false, reason: 'invalid' });
    expect(planRoleOverride({ tenantRole: 'admin', platformAdmin: true }, { tenantRole: 'member', platformAdmin: false }))
      .toEqual({ ok: true, reductions: { dropTenantAdmin: true, dropPlatformAdmin: true } });
    expect(planRoleOverride({ tenantRole: 'admin', platformAdmin: true }, { tenantRole: 'admin', platformAdmin: true }))
      .toEqual({ ok: true, reductions: { dropTenantAdmin: false, dropPlatformAdmin: false } });
    expect(planRoleOverride({ tenantRole: 'member', platformAdmin: false }, { tenantRole: 'member', platformAdmin: false }))
      .toEqual({ ok: true, reductions: { dropTenantAdmin: false, dropPlatformAdmin: false } });
  });

  it('uses an httpOnly, sameSite=strict, site-wide cookie', () => {
    expect(roleOverrideCookieName()).toBe('cremype_dev_role_override');
    expect(roleOverrideCookieOptions()).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/' });
  });
});
