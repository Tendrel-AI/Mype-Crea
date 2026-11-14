import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../../app/actions/dev-roles', () => ({ setDevRoleOverrideAction: vi.fn(), resetDevRoleOverrideAction: vi.fn() }));

import { DevRoleSwitcher, describeRoles } from '../DevRoleSwitcher';

describe('DevRoleSwitcher (KAN-79)', () => {
  it('shows the reduced-roles pill (no top banner) while acting with fewer roles', () => {
    const html = renderToStaticMarkup(<DevRoleSwitcher state={{
      real: { tenantRole: 'admin', platformAdmin: true },
      effective: { tenantRole: 'member', platformAdmin: false },
      reduced: true,
    }} />);
    expect(html).toContain('Modo desarrollo: estás actuando con roles reducidos');
    expect(html).toContain('Roles reducidos:');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('top-0');
  });

  it('shows only the panel toggle, no banner, when acting with real roles', () => {
    const html = renderToStaticMarkup(<DevRoleSwitcher state={{
      real: { tenantRole: 'admin', platformAdmin: false },
      effective: { tenantRole: 'admin', platformAdmin: false },
      reduced: false,
    }} />);
    expect(html).not.toContain('Volver a mis roles');
    expect(html).toContain('Roles de prueba');
  });

  it('describes roles in neutral Spanish', () => {
    expect(describeRoles({ tenantRole: 'member', platformAdmin: false })).toBe('Miembro de la organización · sin administración de plataforma');
    expect(describeRoles({ tenantRole: null, platformAdmin: true })).toBe('administración de plataforma');
  });
});
