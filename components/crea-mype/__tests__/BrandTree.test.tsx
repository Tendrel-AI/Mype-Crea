import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandTree } from '../BrandTree';
import { ConversationMenuItems, chatIdFor } from '../ConversationMenu';

const noop = () => {};
const BRAND = '99999999-9999-4999-8999-999999999999';
const PRODUCT = '88888888-8888-4888-8888-888888888888';
const BRAND_CHAT = '11111111-1111-4111-8111-111111111111';
const PRODUCT_CHAT = '22222222-2222-4222-8222-222222222222';
const LEGACY = '33333333-3333-4333-8333-333333333333';
// Chats are pinned on the entries: none of them is in the (capped) recent list.
const BRANDS = [
  { brandId: BRAND, name: 'Café Andino', chatConversationId: BRAND_CHAT, products: [{ productId: PRODUCT, name: 'Café molido', chatConversationId: PRODUCT_CHAT }] },
  { brandId: 'b2', name: null, products: [] },
];
const LEGACY_ENTRY = { conversationId: LEGACY, brandId: null, productId: null, label: 'Nueva conversación · 20 oct', lastActivityAt: '2026-10-20T15:00:00.000Z' };
const handlers = { onCreateBrand: noop, onImportBrand: noop, onNewProduct: noop, onEditBrand: noop, onEditProduct: noop, onArchiveBrand: noop };
const render = (current = PRODUCT_CHAT, conversations = [LEGACY_ENTRY]) =>
  renderToStaticMarkup(<BrandTree initialBrands={BRANDS} initialConversations={conversations} currentConversationId={current} {...handlers} />);

describe('BrandTree (KAN-111)', () => {
  it('lists every brand with its products, chat links and actions', () => {
    const html = render();
    expect(html).toContain('Crear marca');
    expect(html).toContain('Ya tengo una marca');
    expect(html).toContain('aria-label="Café Andino"');
    expect(html).toContain('Marca sin nombre');
    expect(html).toContain('aria-label="Producto: Café molido"');
    expect(html).toContain(`href="/?conversationId=${BRAND_CHAT}"`);
    expect(html).toContain(`href="/?conversationId=${PRODUCT_CHAT}"`);
    expect(html).toContain('Editar producto');
    expect((html.match(/Nuevo producto/g) ?? []).length).toBe(2);
    expect(html).toContain('Más acciones de Café Andino');
  });

  it('highlights only the current conversation', () => {
    const html = render(PRODUCT_CHAT);
    expect(html).toMatch(new RegExp(`href="/\\?conversationId=${PRODUCT_CHAT}"[^>]*aria-current="page"`));
    expect(html).not.toMatch(new RegExp(`href="/\\?conversationId=${BRAND_CHAT}"[^>]*aria-current`));
  });

  it('shows «Conversaciones anteriores» only when legacy chats exist', () => {
    expect(render()).toContain('Conversaciones anteriores');
    expect(render(PRODUCT_CHAT, [])).not.toContain('Conversaciones anteriores');
  });

  it('the dropdown resolves the same pinned chat links, however old the chat is', () => {
    const html = renderToStaticMarkup(<ConversationMenuItems brands={BRANDS} conversations={[]} currentConversationId="" onCreateBrand={noop} />);
    expect(html).toContain(`href="/?conversationId=${BRAND_CHAT}"`);
    expect(html).toContain(`href="/?conversationId=${PRODUCT_CHAT}"`);
  });

  it('chatIdFor prefers the pinned id and falls back to the recent list', () => {
    const recent = [{ conversationId: 'r1', brandId: BRAND, productId: null, label: 'x', lastActivityAt: '' }];
    expect(chatIdFor(recent, { brandId: BRAND }, 'pinned')).toBe('pinned');
    expect(chatIdFor(recent, { brandId: BRAND }, null)).toBe('r1');
    expect(chatIdFor([], { brandId: BRAND })).toBeUndefined();
  });
});
