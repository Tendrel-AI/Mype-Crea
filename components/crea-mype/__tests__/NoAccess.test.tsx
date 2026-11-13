import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../app/actions/auth', () => ({ signOutAction: async () => {} }));

import { NoAccess } from '../NoAccess';

describe('NoAccess screen (D52)', () => {
  it('shows the account, the request-access copy and a sign-out button', () => {
    const html = renderToStaticMarkup(<NoAccess email="ana@example.invalid" reason="no_active_membership" />);
    expect(html).toContain('No tienes acceso a ninguna organización');
    expect(html).toContain('ana@example.invalid');
    expect(html).toContain('Pide al administrador de tu organización que registre tu correo.');
    expect(html).toContain('Cerrar sesión');
  });

  it('uses the paused copy for a paused organization', () => {
    const html = renderToStaticMarkup(<NoAccess email="a@b.c" reason="organization_paused" />);
    expect(html).toContain('El acceso de tu organización está pausado. Contacta a su administrador.');
    expect(html).not.toContain('Pide al administrador');
  });
});
