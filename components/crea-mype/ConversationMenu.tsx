'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderInput, MessagesSquare, PlusCircle } from 'lucide-react';
import type { BrandListEntry, ConversationListEntry } from '../../src/conversations/selection';

/** KAN-25: opening a conversation is a plain navigation; the server re-checks ownership. */
export function conversationHref(conversationId: string): string {
  return `/?conversationId=${encodeURIComponent(conversationId)}`;
}

export type LoadConversations = () => Promise<
  | { readonly ok: true; readonly conversations: ReadonlyArray<ConversationListEntry>; readonly brands: ReadonlyArray<BrandListEntry> }
  | { readonly ok: false; readonly message: string }
>;

export const UNNAMED_BRAND_LABEL = 'Marca sin nombre';
export const UNNAMED_PRODUCT_LABEL = 'Producto sin nombre';

const itemClass = 'w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium text-orange-600 hover:bg-orange-50';

function ConversationLink({ entry, current }: { entry: ConversationListEntry; current: boolean }) {
  return (
    <a
      role="menuitem"
      href={conversationHref(entry.conversationId)}
      aria-current={current ? 'page' : undefined}
      className={`block truncate px-3 py-2 text-sm hover:bg-neutral-100 ${current ? 'font-semibold text-neutral-900 bg-neutral-50' : 'text-neutral-700'}`}
    >
      {entry.label}
    </a>
  );
}

const subItemClass = 'w-full px-3 py-2 text-left text-xs text-neutral-600 hover:bg-neutral-100';

/**
 * The open menu's content (KAN-85 / KAN-87): «Crear marca» and «Ya tengo una marca» first, then each
 * brand with its own conversations, «Nuevo producto», «Editar marca», «Nueva conversación» and
 * «Archivar marca» (an inline confirm step, no `window.confirm`), its products with their
 * conversations, «Nueva conversación» and «Editar producto», then conversations that predate brands.
 */
export function ConversationMenuItems({
  brands = [],
  conversations,
  currentConversationId,
  onCreateBrand,
  onImportBrand = () => {},
  onNewProduct = () => {},
  onEditBrand = () => {},
  onEditProduct = () => {},
  onNewProductConversation = () => {},
  onNewConversation,
  confirmingBrandId = null,
  onAskArchive = () => {},
  onCancelArchive = () => {},
  onConfirmArchive = () => {},
  error,
}: {
  brands?: ReadonlyArray<BrandListEntry>;
  conversations: ReadonlyArray<ConversationListEntry>;
  currentConversationId: string;
  onCreateBrand: () => void;
  onImportBrand?: () => void;
  onNewProduct?: (brandId: string) => void;
  onEditBrand?: (brandId: string) => void;
  onEditProduct?: (productId: string) => void;
  onNewProductConversation?: (brandId: string, productId: string) => void;
  onNewConversation: (brandId: string) => void;
  confirmingBrandId?: string | null;
  onAskArchive?: (brandId: string) => void;
  onCancelArchive?: () => void;
  onConfirmArchive?: (brandId: string) => void;
  error?: string;
}) {
  const legacy = conversations.filter((entry) => !entry.brandId);
  return (
    <div role="menu" aria-label="Mis conversaciones" className="py-1">
      <button type="button" role="menuitem" onClick={onCreateBrand} className={itemClass}>
        <PlusCircle className="w-4 h-4" />
        Crear marca
      </button>
      <button type="button" role="menuitem" onClick={onImportBrand} className={itemClass}>
        <FolderInput className="w-4 h-4" />
        Ya tengo una marca
      </button>
      <div className="my-1 border-t border-neutral-100" />
      {error && <p role="status" className="px-3 py-2 text-xs text-amber-800">{error}</p>}
      {conversations.length === 0 && brands.length === 0 && !error && (
        <p className="px-3 py-2 text-xs text-neutral-500">Aún no tienes otras conversaciones.</p>
      )}
      {brands.map((brand) => (
        <div key={brand.brandId} role="group" aria-label={brand.name ?? UNNAMED_BRAND_LABEL} className="border-b border-neutral-100 pb-1">
          <p className="px-3 pt-2 text-xs font-semibold uppercase text-neutral-500 truncate">{brand.name ?? UNNAMED_BRAND_LABEL}</p>
          {conversations.filter((entry) => entry.brandId === brand.brandId && !entry.productId).map((entry) => (
            <ConversationLink key={entry.conversationId} entry={entry} current={entry.conversationId === currentConversationId} />
          ))}
          {brand.products.map((product) => (
            <div key={product.productId} role="group" aria-label={`Producto: ${product.name ?? UNNAMED_PRODUCT_LABEL}`} className="ml-3 border-l border-neutral-200">
              <p className="px-3 pt-2 text-xs font-semibold text-neutral-500 truncate">Producto: {product.name ?? UNNAMED_PRODUCT_LABEL}</p>
              {conversations.filter((entry) => entry.productId === product.productId).map((entry) => (
                <ConversationLink key={entry.conversationId} entry={entry} current={entry.conversationId === currentConversationId} />
              ))}
              <button type="button" role="menuitem" onClick={() => onNewProductConversation(brand.brandId, product.productId)} className={subItemClass}>
                Nueva conversación
              </button>
              <button type="button" role="menuitem" onClick={() => onEditProduct(product.productId)} className={subItemClass}>
                Editar producto
              </button>
            </div>
          ))}
          <button type="button" role="menuitem" onClick={() => onNewProduct(brand.brandId)} className={itemClass}>
            Nuevo producto
          </button>
          <button type="button" role="menuitem" onClick={() => onEditBrand(brand.brandId)} className={subItemClass}>
            Editar marca
          </button>
          <button type="button" role="menuitem" onClick={() => onNewConversation(brand.brandId)} className={itemClass}>
            Nueva conversación
          </button>
          {confirmingBrandId === brand.brandId ? (
            <div className="px-3 py-2 text-xs text-neutral-700">
              <p>¿Archivar esta marca? Sus conversaciones dejarán de aparecer aquí y no podrás reactivarla.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => onConfirmArchive(brand.brandId)} className="px-2 py-1 rounded-md bg-red-600 text-white">
                  Sí, archivar
                </button>
                <button type="button" onClick={onCancelArchive} className="px-2 py-1 rounded-md hover:bg-neutral-100">
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button type="button" role="menuitem" onClick={() => onAskArchive(brand.brandId)} className="w-full px-3 py-2 text-left text-xs text-neutral-500 hover:bg-neutral-100">
              Archivar marca
            </button>
          )}
        </div>
      ))}
      {legacy.length > 0 && (
        <div role="group" aria-label="Conversaciones anteriores">
          <p className="px-3 pt-2 text-xs font-semibold uppercase text-neutral-500">Conversaciones anteriores</p>
          {legacy.map((entry) => (
            <ConversationLink key={entry.conversationId} entry={entry} current={entry.conversationId === currentConversationId} />
          ))}
        </div>
      )}
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
  initialBrands = [],
  currentConversationId,
  onCreateBrand,
  onImportBrand,
  onNewProduct,
  onEditBrand,
  onEditProduct,
  onNewProductConversation,
  onNewConversation,
  onArchiveBrand,
  loadConversations,
}: {
  initialConversations: ReadonlyArray<ConversationListEntry>;
  initialBrands?: ReadonlyArray<BrandListEntry>;
  currentConversationId: string;
  onCreateBrand: () => void;
  onImportBrand: () => void;
  onNewProduct: (brandId: string) => void;
  onEditBrand: (brandId: string) => void;
  onEditProduct: (productId: string) => void;
  onNewProductConversation: (brandId: string, productId: string) => void;
  onNewConversation: (brandId: string) => void;
  onArchiveBrand: (brandId: string) => void;
  loadConversations: LoadConversations;
}) {
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState(initialConversations);
  const [brands, setBrands] = useState(initialBrands);
  const [confirmingBrandId, setConfirmingBrandId] = useState<string | null>(null);
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
    setConfirmingBrandId(null);
    if (!next) return;
    void loadConversations()
      .then((result) => {
        if (result.ok) {
          setConversations(result.conversations);
          setBrands(result.brands);
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
            brands={brands}
            conversations={conversations}
            currentConversationId={currentConversationId}
            error={error}
            onCreateBrand={() => { setOpen(false); onCreateBrand(); }}
            onImportBrand={() => { setOpen(false); onImportBrand(); }}
            onNewProduct={(brandId) => { setOpen(false); onNewProduct(brandId); }}
            onEditBrand={(brandId) => { setOpen(false); onEditBrand(brandId); }}
            onEditProduct={(productId) => { setOpen(false); onEditProduct(productId); }}
            onNewProductConversation={(brandId, productId) => { setOpen(false); onNewProductConversation(brandId, productId); }}
            onNewConversation={(brandId) => { setOpen(false); onNewConversation(brandId); }}
            confirmingBrandId={confirmingBrandId}
            onAskArchive={setConfirmingBrandId}
            onCancelArchive={() => setConfirmingBrandId(null)}
            onConfirmArchive={(brandId) => { setOpen(false); setConfirmingBrandId(null); onArchiveBrand(brandId); }}
          />
        </div>
      )}
    </div>
  );
}
