import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatPanel } from '../ChatPanel';
import { Dashboard } from '../Dashboard';
import { LandingPreview } from '../LandingPreview';
import { RestartModal } from '../RestartModal';
import { buildLandingPreviewSrcDoc } from '../landing-src-doc';
import { type BrandAssets, type Message } from '../types';

// Parity checks against the pre-migration component (git show 67eed9f:components/CreaMype.tsx).
// See docs/ui/react-migration-baseline.md.

const EMPTY: BrandAssets = { name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' };
const noop = () => {};

/** Verbatim copy of the pre-migration dashboard iframe template (67eed9f), as a pure function. */
function legacySrcDoc(assets: BrandAssets): string {
  return `
                      <!DOCTYPE html>
                      <html>
                        <head>
                          <meta charset="UTF-8">
                          <meta name="viewport" content="width=device-width, initial-scale=1.0">
                          <script src="https://cdn.tailwindcss.com"></script>
                          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
                          <script>
                            tailwind.config = {
                              theme: {
                                extend: {
                                  fontFamily: {
                                    sans: ['Inter', 'sans-serif'],
                                    display: ['Space Grotesk', 'sans-serif'],
                                  }
                                }
                              }
                            }
                          </script>
                          <style>
                            body { font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }
                            h1, h2, h3, h4, h5, h6 { font-family: 'Space Grotesk', sans-serif; letter-spacing: -0.02em; }
                          </style>
                        </head>
                        <body class="bg-neutral-50 text-neutral-900">
                          ${assets.landingPage.replace(/LOGO_URL_PLACEHOLDER/g, assets.logoUrl || '').replace(/LABEL_URL_PLACEHOLDER/g, assets.labelUrl || '')}
                        </body>
                      </html>
                    `;
}

/** Indentation-insensitive form: the only intended srcDoc difference is leading whitespace. */
const normalize = (doc: string) => doc.split('\n').map((line) => line.trim()).join('\n').trim();

const decodeAttr = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const srcDocsOf = (markup: string) => [...markup.matchAll(/srcDoc="([^"]*)"/gi)].map((match) => decodeAttr(match[1]));

const LANDING = '<section>\n  <img src="LOGO_URL_PLACEHOLDER" alt="logo">\n  <img src="LABEL_URL_PLACEHOLDER">\n  <p>LOGO_URL_PLACEHOLDER</p>\n</section>';

describe('landing preview srcDoc parity (KAN-75)', () => {
  const cases: BrandAssets[] = [
    { ...EMPTY, landingPage: LANDING, logoUrl: 'https://cdn.example/logo.png?a=1&b=2', labelUrl: 'https://cdn.example/label.png' },
    { ...EMPTY, landingPage: LANDING },
    { ...EMPTY, landingPage: '<h1>Sin marcadores</h1><script>console.log("x")</script>', logoUrl: 'https://cdn.example/l.png' },
  ];

  it.each(cases)('matches the pre-migration template except for indentation (%#)', (assets) => {
    expect(normalize(buildLandingPreviewSrcDoc(assets.landingPage, assets.logoUrl, assets.labelUrl))).toBe(normalize(legacySrcDoc(assets)));
  });

  it('dashboard card and full-screen tab render the same srcDoc with the same sandbox', () => {
    const assets = cases[0];
    const dashboard = renderToStaticMarkup(<Dashboard assets={assets} processingAgents={new Set()} step={5} setActiveTab={noop} />);
    const full = renderToStaticMarkup(<LandingPreview assets={assets} setActiveTab={noop} />);
    const [dashboardDoc] = srcDocsOf(dashboard);
    const [fullDoc] = srcDocsOf(full);
    expect(dashboardDoc).toBe(buildLandingPreviewSrcDoc(assets.landingPage, assets.logoUrl, assets.labelUrl));
    expect(fullDoc).toBe(dashboardDoc);
    expect(dashboard).toContain('title="Landing Page Preview"');
    expect(full).toContain('title="Landing Page Full Preview"');
    for (const markup of [dashboard, full]) {
      expect(markup.match(/sandbox="([^"]*)"/)?.[1]).toBe('allow-scripts');
    }
    expect(dashboard).toContain('Ver en pantalla completa');
    expect(full).toContain('Volver al editor');
  });

  it('empty landing HTML keeps the pending states and renders no iframe', () => {
    const dashboard = renderToStaticMarkup(<Dashboard assets={EMPTY} processingAgents={new Set()} step={1} setActiveTab={noop} />);
    const full = renderToStaticMarkup(<LandingPreview assets={EMPTY} setActiveTab={noop} />);
    expect(dashboard).not.toContain('<iframe');
    expect(dashboard).not.toContain('Ver en pantalla completa');
    expect(full).not.toContain('<iframe');
    expect(full).toContain('Aún no hay página web');
    expect(full).toContain('Ir al creador');
  });
});

describe('dashboard pending/processing states (KAN-74)', () => {
  it('shows pending cards, then the logo spinner while logo-agent is processing, then the logo', () => {
    const pending = renderToStaticMarkup(<Dashboard assets={EMPTY} processingAgents={new Set()} step={1} setActiveTab={noop} />);
    expect(pending).toContain('Esperando definición de marca...');
    expect(pending.match(/Pendiente/g)).toHaveLength(4);
    expect(pending).not.toContain('Generando logo...');

    const processing = renderToStaticMarkup(<Dashboard assets={EMPTY} processingAgents={new Set(['logo-agent'])} step={1} setActiveTab={noop} />);
    expect(processing).toContain('Generando logo...');
    expect(processing.match(/Pendiente/g)).toHaveLength(3);

    const done = renderToStaticMarkup(
      <Dashboard assets={{ ...EMPTY, logoUrl: 'https://cdn.example/logo.png' }} processingAgents={new Set(['logo-agent'])} step={3} setActiveTab={noop} />,
    );
    expect(done).toContain('src="https://cdn.example/logo.png"');
    expect(done).not.toContain('Generando logo...');
  });

  it('marks completed and active steps from the derived step', () => {
    const markup = renderToStaticMarkup(<Dashboard assets={EMPTY} processingAgents={new Set()} step={3} setActiveTab={noop} />);
    for (const title of ['Nombre', 'Logo', 'Etiqueta', 'Web', 'Marketing']) expect(markup).toContain(`title="Ir a: ${title}"`);
    expect(markup.match(/bg-orange-600 border-orange-600/g)).toHaveLength(2);
    expect(markup.match(/bg-white border-orange-500/g)).toHaveLength(1);
  });
});

describe('chat panel states (KAN-74)', () => {
  const welcome: Message = { id: 'welcome', role: 'model', text: '**Paso 1: Nombre del Negocio**', isSystem: true };
  const base = {
    assets: EMPTY,
    processingAgents: new Set<string>(),
    conversationId: 'c1',
    handleExportConversation: noop,
    step: 1,
    setShowRestartModal: noop,
    messages: [welcome],
    isLoading: false,
    messagesEndRef: React.createRef<HTMLDivElement>(),
    conversationError: '',
    retryTurn: null,
    submitTurn: noop,
    inputText: '',
    setInputText: noop,
    handleKeyDown: noop,
    handleSend: noop,
    needsNewConversation: false,
  };

  it('renders header controls, Markdown welcome, composer and footer copy', () => {
    const markup = renderToStaticMarkup(<ChatPanel {...base} />);
    expect(markup).toContain('Exportar');
    expect(markup).toContain('Paso 1 de 5');
    expect(markup).toContain('Nuevo');
    expect(markup).toContain('<strong>Paso 1: Nombre del Negocio</strong>');
    expect(markup).toContain('placeholder="Escribe tu mensaje aquí..."');
    expect(markup).toContain('La IA puede cometer errores. Verifica la información importante.');
    expect(markup).not.toContain('Pensando...');
  });

  it('hides export without a conversation and clamps the step label to 5', () => {
    const markup = renderToStaticMarkup(<ChatPanel {...base} conversationId="" step={6} />);
    expect(markup).not.toContain('Exportar');
    expect(markup).toContain('Paso 5 de 5');
  });

  it('shows thinking, error status, retry and uncertain-turn states with the composer disabled', () => {
    const loading = renderToStaticMarkup(<ChatPanel {...base} isLoading inputText="hola" />);
    expect(loading).toContain('Pensando...');
    expect(loading).toMatch(/<textarea[^>]*disabled/);

    const retry = renderToStaticMarkup(<ChatPanel {...base} retryTurn={{ requestId: 'r1', userMessage: 'hola' }} conversationError="Error de prueba" />);
    expect(retry).toContain('Continuar este turno');
    expect(retry).toContain('Error de prueba');
    expect(retry).toMatch(/<textarea[^>]*disabled/);

    const uncertain = renderToStaticMarkup(<ChatPanel {...base} needsNewConversation />);
    expect(uncertain).toContain('inicia un producto nuevo para continuar');
    expect(uncertain).toMatch(/<textarea[^>]*disabled/);

    const idle = renderToStaticMarkup(<ChatPanel {...base} />);
    expect(idle).not.toMatch(/<textarea[^>]*disabled/);
  });

  it('renders notices with the notice style and shows the logo-agent spinner in the header', () => {
    const markup = renderToStaticMarkup(
      <ChatPanel {...base} processingAgents={new Set(['logo-agent'])} messages={[{ id: 'n', role: 'model', text: 'Aviso', isNotice: true }]} />,
    );
    expect(markup).toContain('bg-amber-50 text-amber-900 border border-amber-200');
    expect(markup).toContain('animate-spin');
  });
});

describe('restart modal (KAN-74)', () => {
  it('renders the confirmation copy only when open', () => {
    expect(renderToStaticMarkup(<RestartModal showRestartModal={false} setShowRestartModal={noop} handleRestart={noop} />)).toBe('');
    const open = renderToStaticMarkup(<RestartModal showRestartModal setShowRestartModal={noop} handleRestart={noop} />);
    expect(open).toContain('¿Crear nuevo producto?');
    expect(open).toContain('Esto iniciará un nuevo proceso de creación y descartará el producto actual.');
    expect(open).toContain('Cancelar');
    expect(open).toContain('Sí, crear nuevo');
  });
});
