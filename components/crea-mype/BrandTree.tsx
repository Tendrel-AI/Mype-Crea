'use client';

import React, { useEffect, useRef, useState } from 'react';
import { FolderInput, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, PlusCircle } from 'lucide-react';
import type { BrandListEntry, ConversationListEntry } from '../../src/conversations/selection';
import { UNNAMED_BRAND_LABEL, UNNAMED_PRODUCT_LABEL } from '../../src/conversations/label';
import { ArchiveConfirm, ConversationLink, chatIdFor, type LoadConversations } from './ConversationMenu';

const COLLAPSED_KEY = 'creamype.brandTree.collapsed';
const actionClass = 'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm font-medium text-orange-600 hover:bg-orange-50';

/** Persisted collapse state; storage can be blocked (private mode), so every access is guarded. */
function readCollapsed(): boolean {
  try { return window.localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}

/**
 * KAN-111 / D49: the always-visible brand → products structure (desktop). Same data and handlers as the
 * «Mis conversaciones» dropdown; it reloads its list whenever `refreshKey` changes (conversation switched,
 * form closed) because the page's first-paint list goes stale after creating a brand or product.
 */
export function BrandTree({
  initialBrands,
  initialConversations,
  currentConversationId,
  refreshKey,
  loadConversations,
  onCreateBrand,
  onImportBrand,
  onNewProduct,
  onEditBrand,
  onEditProduct,
  onArchiveBrand,
}: {
  initialBrands: ReadonlyArray<BrandListEntry>;
  initialConversations: ReadonlyArray<ConversationListEntry>;
  currentConversationId: string;
  refreshKey?: string;
  loadConversations?: LoadConversations;
  onCreateBrand: () => void;
  onImportBrand: () => void;
  onNewProduct: (brandId: string) => void;
  onEditBrand: (brandId: string) => void;
  onEditProduct: (productId: string) => void;
  onArchiveBrand: (brandId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [brands, setBrands] = useState(initialBrands);
  const [conversations, setConversations] = useState(initialConversations);
  const [menuBrandId, setMenuBrandId] = useState<string | null>(null);
  const [confirmingBrandId, setConfirmingBrandId] = useState<string | null>(null);

  useEffect(() => { setCollapsed(readCollapsed()); }, []);
  const firstRun = useRef(true);

  useEffect(() => {
    // The first paint already carries fresh data; only later key changes reload.
    if (firstRun.current) { firstRun.current = false; return; }
    if (!loadConversations || refreshKey === undefined) return;
    let live = true;
    void loadConversations()
      .then((result) => {
        if (live && result.ok) { setBrands(result.brands); setConversations(result.conversations); }
      })
      .catch(() => { /* keep the last list; the dropdown reports load errors */ });
    return () => { live = false; };
  }, [loadConversations, refreshKey]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* not persisted */ }
  };

  if (collapsed) {
    return (
      <aside aria-label="Marcas y productos" className="hidden md:flex w-10 shrink-0 flex-col items-center border-r border-neutral-200 bg-white py-3">
        <button type="button" onClick={toggle} aria-label="Mostrar marcas y productos" title="Mostrar marcas y productos" className="text-neutral-500 hover:text-neutral-800">
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  const legacy = conversations.filter((entry) => !entry.brandId);
  return (
    <aside aria-label="Marcas y productos" className="hidden md:flex w-[260px] shrink-0 flex-col border-r border-neutral-200 bg-white overflow-y-auto">
      <div className="flex items-center justify-between px-3 pt-3">
        <h2 className="text-xs font-semibold uppercase text-neutral-500">Mis marcas</h2>
        <button type="button" onClick={toggle} aria-label="Ocultar marcas y productos" title="Ocultar" className="text-neutral-500 hover:text-neutral-800">
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>
      <button type="button" onClick={onCreateBrand} className={actionClass}>
        <PlusCircle className="w-4 h-4" />
        Crear marca
      </button>
      <button type="button" onClick={onImportBrand} className={actionClass}>
        <FolderInput className="w-4 h-4" />
        Ya tengo una marca
      </button>
      <div className="my-1 border-t border-neutral-100" />
      {brands.map((brand) => {
        const brandName = brand.name ?? UNNAMED_BRAND_LABEL;
        const brandChat = chatIdFor(conversations, { brandId: brand.brandId }, brand.chatConversationId);
        return (
          <div key={brand.brandId} role="group" aria-label={brandName} className="border-b border-neutral-100 pb-1">
            <div className="flex items-center justify-between px-3 pt-2">
              <p className="text-xs font-semibold uppercase text-neutral-500 truncate">{brandName}</p>
              <button
                type="button"
                aria-label={`Más acciones de ${brandName}`}
                aria-expanded={menuBrandId === brand.brandId}
                onClick={() => { setConfirmingBrandId(null); setMenuBrandId(menuBrandId === brand.brandId ? null : brand.brandId); }}
                className="text-neutral-500 hover:text-neutral-800"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </div>
            {menuBrandId === brand.brandId && (
              confirmingBrandId === brand.brandId ? (
                <ArchiveConfirm
                  onConfirm={() => { setMenuBrandId(null); setConfirmingBrandId(null); onArchiveBrand(brand.brandId); }}
                  onCancel={() => setConfirmingBrandId(null)}
                />
              ) : (
                <div>
                  <button type="button" onClick={() => { setMenuBrandId(null); onEditBrand(brand.brandId); }} className="w-full px-3 py-1.5 text-left text-xs text-neutral-600 hover:bg-neutral-100">
                    Editar marca
                  </button>
                  <button type="button" onClick={() => setConfirmingBrandId(brand.brandId)} className="w-full px-3 py-1.5 text-left text-xs text-neutral-500 hover:bg-neutral-100">
                    Archivar marca
                  </button>
                </div>
              )
            )}
            {brandChat && <ConversationLink conversationId={brandChat} current={brandChat === currentConversationId} label="Chat de la marca" />}
            {brand.products.map((product) => {
              const chat = chatIdFor(conversations, { brandId: brand.brandId, productId: product.productId }, product.chatConversationId);
              return (
                <div key={product.productId} role="group" aria-label={`Producto: ${product.name ?? UNNAMED_PRODUCT_LABEL}`} className="ml-3 border-l border-neutral-200">
                  <p className="px-3 pt-2 text-xs font-semibold text-neutral-500 truncate">{product.name ?? UNNAMED_PRODUCT_LABEL}</p>
                  {chat && <ConversationLink conversationId={chat} current={chat === currentConversationId} label="Chat del producto" />}
                  <button type="button" onClick={() => onEditProduct(product.productId)} className="w-full px-3 py-1.5 text-left text-xs text-neutral-600 hover:bg-neutral-100">
                    Editar producto
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={() => onNewProduct(brand.brandId)} className={actionClass}>
              <Plus className="w-4 h-4" />
              Nuevo producto
            </button>
          </div>
        );
      })}
      {legacy.length > 0 && (
        <div role="group" aria-label="Conversaciones anteriores">
          <p className="px-3 pt-2 text-xs font-semibold uppercase text-neutral-500">Conversaciones anteriores</p>
          {legacy.map((entry) => (
            <ConversationLink key={entry.conversationId} conversationId={entry.conversationId} current={entry.conversationId === currentConversationId} label={entry.label} />
          ))}
        </div>
      )}
    </aside>
  );
}
