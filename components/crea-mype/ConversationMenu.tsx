'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, MessagesSquare, PlusCircle } from 'lucide-react';
import type { ConversationListEntry } from '../../src/conversations/selection';

/** KAN-25: opening a conversation is a plain navigation; the server re-checks ownership. */
export function conversationHref(conversationId: string): string {
  return `/?conversationId=${encodeURIComponent(conversationId)}`;
}

export type LoadConversations = () => Promise<
  | { readonly ok: true; readonly conversations: ReadonlyArray<ConversationListEntry> }
  | { readonly ok: false; readonly message: string }
>;

/** The open menu's content: «Nueva conversación» first, then the owner's latest conversations. */
export function ConversationMenuItems({
  conversations,
  currentConversationId,
  onNewConversation,
  error,
}: {
  conversations: ReadonlyArray<ConversationListEntry>;
  currentConversationId: string;
  onNewConversation: () => void;
  error?: string;
}) {
  return (
    <div role="menu" aria-label="Mis conversaciones" className="py-1">
      <button
        type="button"
        role="menuitem"
        onClick={onNewConversation}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium text-orange-600 hover:bg-orange-50"
      >
        <PlusCircle className="w-4 h-4" />
        Nueva conversación
      </button>
      <div className="my-1 border-t border-neutral-100" />
      {error && <p role="status" className="px-3 py-2 text-xs text-amber-800">{error}</p>}
      {conversations.length === 0 && !error && (
        <p className="px-3 py-2 text-xs text-neutral-500">Aún no tienes otras conversaciones.</p>
      )}
      {conversations.map((entry) => {
        const current = entry.conversationId === currentConversationId;
        return (
          <a
            key={entry.conversationId}
            role="menuitem"
            href={conversationHref(entry.conversationId)}
            aria-current={current ? 'page' : undefined}
            className={`block truncate px-3 py-2 text-sm hover:bg-neutral-100 ${current ? 'font-semibold text-neutral-900 bg-neutral-50' : 'text-neutral-700'}`}
          >
            {entry.label}
          </a>
        );
      })}
    </div>
  );
}

/**
 * «Mis conversaciones» dropdown in the ChatPanel header. Starts with the list the
 * page rendered and refreshes it from the server each time it opens, so a
 * conversation started or renamed in this session shows up.
 */
export function ConversationMenu({
  initialConversations,
  currentConversationId,
  onNewConversation,
  loadConversations,
}: {
  initialConversations: ReadonlyArray<ConversationListEntry>;
  currentConversationId: string;
  onNewConversation: () => void;
  loadConversations: LoadConversations;
}) {
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState(initialConversations);
  const [error, setError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    void loadConversations()
      .then((result) => {
        if (result.ok) {
          setConversations(result.conversations);
          setError('');
        } else {
          setError(result.message);
        }
      })
      .catch(() => setError('No pudimos cargar tus conversaciones. Inténtalo de nuevo.'));
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-xs font-medium px-2.5 py-1 rounded-full bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-colors flex items-center gap-1"
        title="Ver y cambiar de conversación"
      >
        <MessagesSquare className="w-3 h-3" />
        Mis conversaciones
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 max-h-96 overflow-y-auto rounded-xl border border-neutral-200 bg-white shadow-lg z-30">
          <ConversationMenuItems
            conversations={conversations}
            currentConversationId={currentConversationId}
            error={error}
            onNewConversation={() => { setOpen(false); onNewConversation(); }}
          />
        </div>
      )}
    </div>
  );
}
