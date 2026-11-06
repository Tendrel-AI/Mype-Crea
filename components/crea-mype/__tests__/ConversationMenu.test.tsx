import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConversationMenu, ConversationMenuItems, conversationHref } from '../ConversationMenu';
import { ChatPanel } from '../ChatPanel';
import { RestartModal } from '../RestartModal';
import type { BrandAssets } from '../types';

const noop = () => {};
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ENTRIES = [
  { conversationId: A, label: 'Café Andino · 24 oct', lastActivityAt: '2026-10-24T15:00:00.000Z' },
  { conversationId: B, label: 'Nueva conversación · 20 oct', lastActivityAt: '2026-10-20T15:00:00.000Z' },
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
      <ConversationMenu initialConversations={ENTRIES} currentConversationId={A} onNewConversation={noop} loadConversations={loadNever} />,
    );
    expect(markup).toContain('Mis conversaciones');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('Café Andino');
  });

  it('renders «Nueva conversación» first, then one entry per conversation with its server label', () => {
    const markup = renderToStaticMarkup(
      <ConversationMenuItems conversations={ENTRIES} currentConversationId={A} onNewConversation={noop} />,
    );
    const items = [...markup.matchAll(/role="menuitem"[^>]*>(.*?)<\/(?:a|button)>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    expect(items).toEqual(['Nueva conversación', 'Café Andino · 24 oct', 'Nueva conversación · 20 oct']);
    expect(markup).toContain('aria-label="Mis conversaciones"');
  });

  it('navigates to the selected conversation and marks the current one', () => {
    const tree = ConversationMenuItems({ conversations: ENTRIES, currentConversationId: A, onNewConversation: noop });
    const links = findAll(tree, (el) => el.type === 'a');
    expect(links.map((link) => link.props.href)).toEqual([`/?conversationId=${A}`, `/?conversationId=${B}`]);
    expect(conversationHref(B)).toBe(`/?conversationId=${B}`);
    const markup = renderToStaticMarkup(<>{tree}</>);
    expect(markup).toMatch(new RegExp(`href="/\\?conversationId=${A}"[^>]*aria-current="page"`));
    expect(markup).not.toMatch(new RegExp(`href="/\\?conversationId=${B}"[^>]*aria-current`));
  });

  it('shows an empty state and a load error in Spanish with tú', () => {
    expect(renderToStaticMarkup(<ConversationMenuItems conversations={[]} currentConversationId="" onNewConversation={noop} />))
      .toContain('Aún no tienes otras conversaciones.');
    expect(renderToStaticMarkup(
      <ConversationMenuItems conversations={[]} currentConversationId="" onNewConversation={noop} error="No pudimos cargar tus conversaciones. Inténtalo de nuevo." />,
    )).toContain('No pudimos cargar tus conversaciones. Inténtalo de nuevo.');
  });

  it('«Nueva conversación» opens the restart modal, whose copy keeps the current conversation', () => {
    let showRestartModal = false;
    const setShowRestartModal = vi.fn((open: boolean) => { showRestartModal = open; });
    const tree = ConversationMenuItems({
      conversations: ENTRIES, currentConversationId: A, onNewConversation: () => setShowRestartModal(true),
    });
    const [newButton] = findAll(tree, (el) => el.type === 'button' && textOf(el.props.children).includes('Nueva conversación'));
    newButton.props.onClick?.();
    expect(setShowRestartModal).toHaveBeenCalledWith(true);

    const modal = renderToStaticMarkup(
      <RestartModal showRestartModal={showRestartModal} setShowRestartModal={setShowRestartModal} handleRestart={noop} />,
    );
    expect(modal).toContain('Tu conversación actual seguirá disponible en «Mis conversaciones».');
    expect(modal).not.toContain('descartará');
    expect(modal).not.toMatch(/\b(querés|tenés|podés|vos|sos)\b/);
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
    setShowRestartModal: noop,
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

  it('places «Mis conversaciones» in the header right before the restart button', () => {
    const markup = renderToStaticMarkup(
      <ChatPanel {...base} conversationMenu={<ConversationMenu initialConversations={ENTRIES} currentConversationId={A} onNewConversation={noop} loadConversations={loadNever} />} />,
    );
    const menuAt = markup.indexOf('Mis conversaciones');
    const restartAt = markup.indexOf('title="Crear un nuevo producto"');
    expect(menuAt).toBeGreaterThan(-1);
    expect(restartAt).toBeGreaterThan(menuAt);
  });

  it('shows «No encontramos esta conversación.» with a link to the latest conversation', () => {
    const markup = renderToStaticMarkup(<ChatPanel {...base} conversationId="" conversationNotFound />);
    expect(markup).toContain('No encontramos esta conversación.');
    expect(markup).toMatch(/<a [^>]*href="\/"[^>]*>Ir a mi última conversación<\/a>/);
    expect(markup).toMatch(/<textarea[^>]*disabled/);
    expect(renderToStaticMarkup(<ChatPanel {...base} />)).not.toContain('No encontramos esta conversación.');
  });
});
