import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandAssetsReadOnly, BRAND_CHAT_LABEL, MISSING_ASSET_COPY } from '../BrandAssetsReadOnly';
import { Dashboard } from '../Dashboard';
import type { BrandAssets } from '../types';

const noop = () => {};
const BRAND_CHAT = '11111111-1111-4111-8111-111111111111';
const base: BrandAssets = { name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' };
const props = { assets: base, processingAgents: new Set<string>(), step: 1, setActiveTab: noop };
const COMMANDS = ['Generar', 'Iterar', 'Aprobar'];

describe('BrandAssetsReadOnly', () => {
  it('shows approved logo, name and tagline and links to the brand chat', () => {
    const html = renderToStaticMarkup(
      <BrandAssetsReadOnly assets={{ logoUrl: '/api/assets/l1', name: 'Café Andino', tagline: 'Sabor de altura' }} brandConversationId={BRAND_CHAT} />,
    );
    expect(html).toContain('/api/assets/l1');
    expect(html).toContain('Café Andino');
    expect(html).toContain('Sabor de altura');
    expect(html).toContain(`href="/?conversationId=${BRAND_CHAT}"`);
    expect(html).toContain(BRAND_CHAT_LABEL);
    expect(html).not.toContain(MISSING_ASSET_COPY);
  });

  it('says «Aún no lo has creado» for each missing asset and hides the chat link when the brand chat is unknown', () => {
    const html = renderToStaticMarkup(<BrandAssetsReadOnly assets={null} brandConversationId={null} />);
    expect(html.split(MISSING_ASSET_COPY)).toHaveLength(4);
    expect(html).not.toContain(BRAND_CHAT_LABEL);
  });
});

describe('Dashboard in a product vs brand conversation', () => {
  const logo = <button>Generar logo</button>;
  const names = <button>Iterar nombre</button>;

  it('product chat: label first, read-only brand panel, no brand command buttons', () => {
    const html = renderToStaticMarkup(
      <Dashboard {...props} logoControls={logo} nameControls={names} labelControls={<p>tarjeta-etiqueta</p>} brandAssetsPanel={<p>panel-marca</p>} />,
    );
    expect(html).toContain('panel-marca');
    expect(html.indexOf('tarjeta-etiqueta')).toBeLessThan(html.indexOf('panel-marca'));
    for (const word of COMMANDS) expect(html).not.toContain(word);
  });

  it('brand chat is unchanged: command controls render and there is no brand panel', () => {
    const html = renderToStaticMarkup(<Dashboard {...props} logoControls={logo} nameControls={names} />);
    expect(html).toContain('Generar logo');
    expect(html).toContain('Iterar nombre');
    expect(html).not.toContain('Recursos de tu marca');
  });
});
