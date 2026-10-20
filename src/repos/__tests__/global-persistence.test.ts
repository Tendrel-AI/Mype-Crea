import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../../db/global-transaction', () => ({
  withGlobalTransaction: async (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query }),
}));

import { globalIdentityRepo } from '../global-identity';
import { globalOrganizationsRepo } from '../global-organizations';

describe('global persistence repositories', () => {
  beforeEach(() => query.mockReset());

  it('checks persisted superadmin status and bootstraps only once', async () => {
    const identity = globalIdentityRepo();
    query.mockResolvedValueOnce({ rows: [{ allowed: true }] });
    await expect(identity.isSuperadmin('workos_user')).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain('revoked_at IS NULL');

    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ completed_at: new Date() }] });
    await expect(identity.bootstrapSuperadmin('workos_user')).resolves.toBe('already_bootstrapped');
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toContain('platform_bootstrap_state');
    expect(query.mock.calls[2][0]).not.toContain('FOR UPDATE');
    query.mockResolvedValueOnce({ rows: [{ allowed: false }] });
    await expect(identity.isSuperadmin('workos_user')).resolves.toBe(false);
  });

  it('resolves organization activity from persisted status', async () => {
    const organizations = globalOrganizationsRepo();
    query.mockResolvedValueOnce({ rows: [{ id: 'tenant-1', status: 'inactive' }] });
    await expect(organizations.findByWorkosOrgId('org-1')).resolves.toEqual({
      tenantId: 'tenant-1', status: 'inactive',
    });
    query.mockResolvedValueOnce({ rows: [{ id: 'tenant-1', status: 'active' }] });
    await expect(organizations.isActive('org-1')).resolves.toBe(true);
  });

  it('lists only safe superadmin fields and audits a self-revoke before removing the role', async () => {
    const identity = globalIdentityRepo();
    const grantedAt = new Date('2026-01-01T00:00:00Z');
    query.mockResolvedValueOnce({ rows: [{ workos_user_id: 'user-1', granted_at: grantedAt, revoked_at: null }] });
    await expect(identity.listSuperadmins()).resolves.toEqual([
      { workosUserId: 'user-1', grantedAt, revokedAt: null },
    ]);

    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ authorized: true }] });
    query.mockResolvedValueOnce({ rows: [] }); // transaction-local actor GUC
    query.mockResolvedValueOnce({ rows: [{ total: '2', target_active: true }] });
    query.mockResolvedValueOnce({ rows: [] }); // audit insert
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // revoke update
    await expect(identity.revokeSuperadmin('user-1', 'user-1', 'rotate access')).resolves.toBe(true);
    const auditIndex = query.mock.calls.findIndex(([sql]) => String(sql).includes('INSERT INTO platform_audit_events'));
    const revokeIndex = query.mock.calls.findIndex(([sql]) => String(sql).includes('UPDATE platform_superadmins'));
    expect(auditIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeLessThan(revokeIndex);
  });

  it('does not allow revoking the only active superadmin', async () => {
    const identity = globalIdentityRepo();
    query.mockResolvedValueOnce({ rows: [{ authorized: true }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ total: '1', target_active: true }] });
    await expect(identity.revokeSuperadmin('user-1', 'user-1', 'rotate access'))
      .rejects.toThrow('único administrador global activo');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE platform_superadmins'))).toBe(false);
  });
});
