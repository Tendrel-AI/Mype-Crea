import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({ getAiConfigAdminData: vi.fn() }));

vi.mock('../../../actions/ai-config', () => ({ getAiConfigAdminData: mocks.getAiConfigAdminData }));
vi.mock('../../../../components/AiConfigurationAdmin', () => ({ default: () => <div>admin-ui</div> }));

import AiConfigurationAdminPage from '../page';

async function render(): Promise<string> {
  return renderToStaticMarkup(await AiConfigurationAdminPage());
}

describe('/admin/ai page (KAN-80)', () => {
  it('sends a platform admin without a proof to /platform/mfa and back', async () => {
    mocks.getAiConfigAdminData.mockResolvedValueOnce({ ok: false, reason: 'mfa_required', error: 'x' });
    const html = await render();
    expect(html).toContain('href="/platform/mfa?next=/admin/ai"');
    expect(html).toContain('primero verifica tu código de autenticación');
    expect(html).not.toMatch(/\b(querés|tenés|podés|ingresá|hacé|mirá|vos|sos)\b/i);
  });

  it('keeps the generic message for other failures', async () => {
    mocks.getAiConfigAdminData.mockResolvedValueOnce({ ok: false, error: 'x' });
    const html = await render();
    expect(html).toContain('No tienes acceso administrativo');
    expect(html).not.toContain('/platform/mfa');
  });

  it('renders the admin UI when the data loads', async () => {
    mocks.getAiConfigAdminData.mockResolvedValueOnce({ ok: true, data: { tenantId: 't' } });
    expect(await render()).toContain('admin-ui');
  });
});
