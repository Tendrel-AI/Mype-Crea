import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConversationMenu, ConversationMenuItems, conversationHref } from '../ConversationMenu';
import { ChatPanel } from '../ChatPanel';
import { contextLine } from '../ChatPanel';
import type { BrandAssets } from '../types';

const noop = () => {};
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const BRAND = '99999999-9999-4999-8999-999999999999';
const PRODUCT = '88888888-8888-4888-8888-888888888888';
const P_CONV = '33333333-3333-4333-8333-333333333333';
const BRANDS = [{ brandId: BRAND, name: 'Café Andino', products: [] }];
const BRANDS_WITH_PRODUCT = [{ brandId: BRAND, name: 'Café Andino', products: [{ productId: PRODUCT, name: 'Café molido' }] }];
const ENTRIES = [
  { conversationId: A, brandId: BRAND, productId: null, label: 'Café Andino · 24 oct', lastActivityAt: '2026-10-24T15:00:00.000Z' },
  { conversationId: B, brandId: null, productId: null, label: 'Nueva conversación · 20 oct', lastActivityAt: '2026-10-20T15:00:00.000Z' },
];
const loadNever = () => new Promise<never>(() => {});

type AnyElement = React.ReactElement<{ children?: React.ReactNode; onClick?: () => void; role?: string; href?: string }>;

/** Walk a rendered element tree (no DOM) and return every element matching `match`. */
function findAll(node: React.ReactNode, match: (el: AnyElement) => boolean): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, match));
  if (!React.isValidElement(node)) return [];
  const el = node as AnyElement;
  return [...(match(el) ? [el] : []), ...findAll(el.props.children, match)];
}

const textOf = (node: React.ReactNode): string =>
  Array.isArray(node) ? node.map(textOf).join('')
    : typeof node === 'string' || typeof node === 'number' ? String(node)
      : React.isValidElement(node) ? textOf((node as AnyElement).props.children) : '';

describe('«Mis conversaciones» menu (KAN-25)', () => {
  it('renders only the closed trigger until opened', () => {
    const markup = renderToStaticMarkup(
      <ConversationMenu initialConversations={ENTRIES} currentConversationId={A} initialBrands={BRANDS} onCreateBrand={noop} onImportBrand={noop} onNewProduct={noop} onEditBrand={noop} onEditProduct={noop} onNewProductConversation={noop} onNewConversation={noop} onArchiveBrand={noop} loadConversations={loadNever} />,
    );
    expect(markup).toContain('Mis conversaciones');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('Café Andino');
  });

  it('renders «Crear marca» and «Ya tengo una marca» first, then each brand group with its actions, then legacy conversations', () => {
    const markup = renderToStaticMarkup(
      <ConversationMenuItems brands={BRANDS} conversations={ENTRIES} currentConversationId={A} onCreateBrand={noop} onNewConversation={noop} />,
    );
    const items = [...markup.matchAll(/role="menuitem"[^>]*>(.*?)<\/(?:a|button)>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    expect(items).toEqual(['Crear marca', 'Ya tengo una marca', 'Café Andino · 24 oct', 'Nuevo producto', 'Editar marca', 'Nueva conversación', 'Archivar marca', 'Nueva conversación · 20 oct']);
    expect(markup).toContain('aria-label="Conversaciones anteriores"');
    expect(markup).toContain('aria-label="Mis conversaciones"');
  });

  it('navigates to the selected conversation and marks the current one', () => {
    const tree = ConversationMenuItems({ brands: BRANDS, conversations: ENTRIES, currentConversationId: A, onCreateBrand: noop, onNewConversation: noop });
    const markup = renderToStaticMarkup(<>{tree}</>);
    expect([...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([`/?conversationId=${A}`, `/?conversationId=${B}`]);
    expect(conversationHref(B)).toBe(`/?conversationId=${B}`);
    expect(markup).toMatch(new RegExp(`href="/\\?conversationId=${A}"[^>]*aria-current="page"`));
    expect(markup).not.toMatch(new RegExp(`href="/\\?conversationId=${B}"[^>]*aria-current`));
  });

  it('shows an empty state and a load error in Spanish with tú', () => {
    expect(renderToStaticMarkup(<ConversationMenuItems conversations={[]} currentConversationId="" onCreateBrand={noop} onNewConversation={noop} />))
      .toContain('Aún no tienes otras conversaciones.');
    expect(renderToStaticMarkup(
      <ConversationMenuItems conversations={[]} currentConversationId="" onCreateBrand={noop} onNewConversation={noop} error="No pudimos cargar tus conversaciones. Inténtalo de nuevo." />,
    )).toContain('No pudimos cargar tus conversaciones. Inténtalo de nuevo.');
  });

  it('«Crear marca», «Ya tengo una marca», «Nuevo producto», «Editar marca» and «Editar producto» call their handlers with the right ids', () => {
    const handlers = { onCreateBrand: vi.fn(), onImportBrand: vi.fn(), onNewProduct: vi.fn(), onEditBrand: vi.fn(), onEditProduct: vi.fn(), onNewProductConversation: vi.fn() };
    const entries = [...ENTRIES, { conversationId: P_CONV, brandId: BRAND, productId: PRODUCT, label: 'Café molido · 25 oct', lastActivityAt: '2026-10-25T15:00:00.000Z' }];
    const tree = ConversationMenuItems({ brands: BRANDS_WITH_PRODUCT, conversations: entries, currentConversationId: A, onNewConversation: noop, ...handlers });
    const click = (label: string) => findAll(tree, (el) => el.type === 'button' && textOf(el.props.children) === label)[0].props.onClick?.();
    click('Crear marca'); click('Ya tengo una marca'); click('Nuevo producto'); click('Editar marca'); click('Editar producto');
    // Product-level «Nueva conversación» renders before the brand-level one.
    click('Nueva conversación');
    expect(handlers.onNewProductConversation).toHaveBeenCalledWith(BRAND, PRODUCT);
    expect(handlers.onCreateBrand).toHaveBeenCalledTimes(1);
    expect(handlers.onImportBrand).toHaveBeenCalledTimes(1);
    expect(handlers.onNewProduct).toHaveBeenCalledWith(BRAND);
    expect(handlers.onEditBrand).toHaveBeenCalledWith(BRAND);
    expect(handlers.onEditProduct).toHaveBeenCalledWith(PRODUCT);
  });

  it('groups conversations: brand conversations under the brand, product conversations under their product', () => {
    const entries = [...ENTRIES, { conversationId: P_CONV, brandId: BRAND, productId: PRODUCT, label: 'Café molido · 25 oct', lastActivityAt: '2026-10-25T15:00:00.000Z' }];
    const markup = renderToStaticMarkup(
      <ConversationMenuItems brands={BRANDS_WITH_PRODUCT} conversations={entries} currentConversationId={A} onCreateBrand={noop} onNewConversation={noop} />,
    );
    const productGroup = markup.slice(markup.indexOf('aria-label="Producto: Café molido"'));
    expect(productGroup).toContain('Café molido · 25 oct');
    expect(markup.indexOf('Café Andino · 24 oct')).toBeLessThan(markup.indexOf('aria-label="Producto: Café molido"'));
    expect(markup.slice(0, markup.indexOf('aria-label="Producto: Café molido"'))).not.toContain('Café molido · 25 oct');
  });

  it('«Nueva conversación» of a brand passes that brand id', () => {
    const onNewConversation = vi.fn();
    const tree = ConversationMenuItems({ brands: BRANDS, conversations: ENTRIES, currentConversationId: A, onCreateBrand: noop, onNewConversation });
    const [button] = findAll(tree, (el) => el.type === 'button' && textOf(el.props.children) === 'Nueva conversación');
    button.props.onClick?.();
    expect(onNewConversation).toHaveBeenCalledWith(BRAND);
  });

  it('«Archivar marca» asks for an in-UI confirmation and only then archives', () => {
    const onAskArchive = vi.fn();
    const onConfirmArchive = vi.fn();
    const asking = ConversationMenuItems({
      brands: BRANDS, conversations: ENTRIES, currentConversationId: A, onCreateBrand: noop, onNewConversation: noop, onAskArchive, onConfirmArchive,
    });
    const [archive] = findAll(asking, (el) => el.type === 'button' && textOf(el.props.children) === 'Archivar marca');
    archive.props.onClick?.();
    expect(onAskArchive).toHaveBeenCalledWith(BRAND);
    expect(onConfirmArchive).not.toHaveBeenCalled();

    const confirming = ConversationMenuItems({
      brands: BRANDS, conversations: ENTRIES, currentConversationId: A, onCreateBrand: noop, onNewConversation: noop,
      confirmingBrandId: BRAND, onConfirmArchive,
    });
    expect(renderToStaticMarkup(<>{confirming}</>)).toContain('¿Archivar esta marca?');
    const [confirm] = findAll(confirming, (el) => el.type === 'button' && textOf(el.props.children) === 'Sí, archivar');
    confirm.props.onClick?.();
    expect(onConfirmArchive).toHaveBeenCalledWith(BRAND);
  });

  it('shows «Marca sin nombre» for a brand without a name', () => {
    const markup = renderToStaticMarkup(
      <ConversationMenuItems brands={[{ brandId: BRAND, name: null, products: [] }]} conversations={[]} currentConversationId="" onCreateBrand={noop} onNewConversation={noop} />,
    );
    expect(markup).toContain('Marca sin nombre');
  });
});

describe('ChatPanel with the conversation menu and the not-found state (KAN-25)', () => {
  const EMPTY: BrandAssets = { name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' };
  const base = {
    assets: EMPTY,
    processingAgents: new Set<string>(),
    conversationId: A,
    handleExportConversation: noop,
    step: 1,
    onCreateBrand: noop,
    onImportBrand: noop,
    messages: [],
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

  it('places «Mis conversaciones» in the header right before the «Nuevo» (create brand) button', () => {
    const markup = renderToStaticMarkup(
      <ChatPanel {...base} conversationMenu={<ConversationMenu initialConversations={ENTRIES} currentConversationId={A} initialBrands={BRANDS} onCreateBrand={noop} onImportBrand={noop} onNewProduct={noop} onEditBrand={noop} onEditProduct={noop} onNewProductConversation={noop} onNewConversation={noop} onArchiveBrand={noop} loadConversations={loadNever} />} />,
    );
    const menuAt = markup.indexOf('Mis conversaciones');
    const restartAt = markup.indexOf('title="Crear una marca nueva"');
    expect(menuAt).toBeGreaterThan(-1);
    expect(restartAt).toBeGreaterThan(menuAt);
  });

  it('the header shows «Marca: X» and, for a product conversation, «· Producto: Y»; a legacy conversation shows neither', () => {
    const brandOnly = { brandId: BRAND, brandName: 'Café Andino', productId: null, productName: null };
    expect(contextLine(brandOnly)).toBe('Marca: Café Andino');
    expect(contextLine({ ...brandOnly, productId: PRODUCT, productName: 'Café molido' })).toBe('Marca: Café Andino · Producto: Café molido');
    expect(contextLine({ ...brandOnly, brandName: null, productId: PRODUCT, productName: null })).toBe('Marca: Marca sin nombre · Producto: Producto sin nombre');
    expect(contextLine({ brandId: null, brandName: null, productId: null, productName: null })).toBeNull();
    expect(contextLine(null)).toBeNull();
    const markup = renderToStaticMarkup(<ChatPanel {...base} context={{ ...brandOnly, productId: PRODUCT, productName: 'Café molido' }} />);
    expect(markup).toContain('Marca: Café Andino · Producto: Café molido');
    expect(renderToStaticMarkup(<ChatPanel {...base} />)).not.toContain('Marca:');
  });

  it('with no conversation the composer is disabled and «Crear marca» / «Ya tengo una marca» are offered', () => {
    const markup = renderToStaticMarkup(<ChatPanel {...base} conversationId="" />);
    expect(markup).toContain('Crear marca');
    expect(markup).toContain('Ya tengo una marca');
    expect(markup).toMatch(/<textarea[^>]*disabled/);
  });

  it('shows «No encontramos esta conversación.» with a link to the latest conversation', () => {
    const markup = renderToStaticMarkup(<ChatPanel {...base} conversationId="" conversationNotFound />);
    expect(markup).toContain('No encontramos esta conversación.');
    expect(markup).toMatch(/<a [^>]*href="\/"[^>]*>Ir a mi última conversación<\/a>/);
    expect(markup).toMatch(/<textarea[^>]*disabled/);
    expect(renderToStaticMarkup(<ChatPanel {...base} />)).not.toContain('No encontramos esta conversación.');
  });
});
