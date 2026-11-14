import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../app/actions/auth', () => ({ signOutAction: async () => {} }));
vi.mock('../../ThemeToggle', () => ({ ThemeToggle: () => null }));

import { Sidebar } from '../Sidebar';

const render = (isTenantAdmin?: boolean) => renderToStaticMarkup(
  <Sidebar
    activeTab="create"
    setActiveTab={() => {}}
    isSidebarOpen
    setIsSidebarOpen={() => {}}
    assets={{} as never}
    processingAgents={new Set()}
    userEmail="ana@example.invalid"
    userName="Ana"
    isTenantAdmin={isTenantAdmin}
  />,
);

describe('Sidebar administration link (D52)', () => {
  it('shows «Administración» to /admin for tenant admins', () => {
    const html = render(true);
    expect(html).toContain('href="/admin"');
    expect(html).toContain('Administración');
  });

  it('hides it from members and when the role is unknown', () => {
    expect(render(false)).not.toContain('/admin');
    expect(render(undefined)).not.toContain('/admin');
  });
});
