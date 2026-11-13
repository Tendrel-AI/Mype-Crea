'use client';

import React from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Loader2, Sparkles, PlusCircle, Download, Paperclip, Image as ImageIcon } from 'lucide-react';
import { LAB_UPLOAD_LABEL, PHOTO_UPLOAD_LABEL } from './lab-upload-copy';
import { type BrandAssets, type Message } from './types';
import { LIVE_CONNECTION_LOST_MESSAGE } from './live-updates';
import type { ConversationContext } from '../../src/conversations/selection';
import { UNNAMED_BRAND_LABEL, UNNAMED_PRODUCT_LABEL } from './ConversationMenu';

/** «Marca: X» plus «· Producto: Y» for a product conversation; null for a legacy conversation. */
export function contextLine(context: ConversationContext | null | undefined): string | null {
  if (!context?.brandId) return null;
  const brand = `Marca: ${context.brandName?.trim() || UNNAMED_BRAND_LABEL}`;
  return context.productId ? `${brand} · Producto: ${context.productName?.trim() || UNNAMED_PRODUCT_LABEL}` : brand;
}


export function ChatPanel({ assets, processingAgents, conversationId, handleExportConversation, onCreateBrand, onImportBrand, creationBlocked = false, context, messages, isLoading, messagesEndRef, conversationError, retryTurn, submitTurn, inputText, setInputText, handleKeyDown, handleSend, needsNewConversation, mobileDeliverablePanel, conversationMenu, conversationNotFound = false, liveConnectionLost = false, labUpload, photoUpload }: { assets: BrandAssets; processingAgents: Set<string>; conversationId: string; handleExportConversation: () => void; /** KAN-87: opens the brand form. */ onCreateBrand: () => void; /** KAN-87: opens the «Ya tengo una marca» form. */ onImportBrand: () => void; /** KAN-27: the terms gate is unavailable; creating brands is disabled and the error message is shown instead. */ creationBlocked?: boolean; /** KAN-87: brand/product of the open conversation, for the header line. */ context?: ConversationContext | null; messages: Message[]; isLoading: boolean; messagesEndRef: React.RefObject<HTMLDivElement | null>; conversationError: string; retryTurn: { requestId: string; userMessage: string } | null; submitTurn: (text: string, requestId: string) => void; inputText: string; setInputText: (text: string) => void; handleKeyDown: (e: React.KeyboardEvent) => void; handleSend: () => void; needsNewConversation: boolean; /** KAN-28: deliverable commands for small screens, where the dashboard is hidden. */ mobileDeliverablePanel?: React.ReactNode; /** KAN-25: «Mis conversaciones» dropdown, next to the restart button. */ conversationMenu?: React.ReactNode; /** KAN-25: the requested conversation is not the caller's (or does not exist). */ conversationNotFound?: boolean; /** KAN-30: the SSE stream is gone; offer a reload of the durable state. */ liveConnectionLost?: boolean; /** D32: product conversations only; uploads lab-report PDFs for the nutrition label. */ labUpload?: { busy: boolean; onFiles: (files: File[]) => void }; /** Product conversations only; uploads product photos for the advertising photo. */ photoUpload?: { busy: boolean; onFiles: (files: File[]) => void } }) {
  return (
<>
          {/* Left Panel: Chat Interface */}
      <div className="w-full md:w-1/2 lg:w-5/12 flex flex-col border-r border-neutral-200 bg-white/50 relative z-10">
        <div className="p-4 border-b border-neutral-200 bg-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center text-orange-500 overflow-hidden">
              {assets.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={assets.logoUrl} alt="Logo" className="w-full h-full object-cover" />
              ) : processingAgents.has('logo-agent') ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Sparkles size={18} />
              )}
            </div>
            <h1 className="font-semibold text-lg tracking-tight">CreaMype</h1>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {conversationId && <button
              type="button"
              onClick={() => void handleExportConversation()}
              className="text-xs font-medium px-2.5 py-1 rounded-full bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-colors flex items-center gap-1"
              title="Descargar la conversación y sus registros"
            ><Download className="w-3 h-3" />Exportar</button>}
            {conversationMenu}
            <button
              onClick={onCreateBrand}
              disabled={creationBlocked}
              className="text-xs font-medium px-2.5 py-1 rounded-full bg-orange-50 disabled:opacity-50 text-orange-600 hover:bg-orange-100 transition-colors flex items-center gap-1"
              title="Crear una marca nueva"
            >
              <PlusCircle className="w-3 h-3" />
              Nuevo
            </button>
          </div>
        </div>
        {contextLine(context) && (
          <p data-testid="conversation-context" className="px-4 py-2 border-b border-neutral-100 bg-neutral-50 text-xs font-medium text-neutral-700 truncate">
            {contextLine(context)}
          </p>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
          {!conversationId && !conversationNotFound && !creationBlocked && (
            <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
              <p className="font-medium text-neutral-900">Empieza creando tu marca</p>
              <p className="mt-1">Cuéntanos de tu negocio para crear tu primera conversación.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={onCreateBrand} className="rounded-lg bg-orange-600 px-3 py-2 font-medium text-white hover:bg-orange-700 dark:hover:bg-orange-500">Crear marca</button>
                <button type="button" onClick={onImportBrand} className="rounded-lg border border-neutral-300 px-3 py-2 font-medium hover:bg-neutral-100">Ya tengo una marca</button>
              </div>
            </div>
          )}
          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                    msg.isNotice
                      ? 'bg-amber-50 text-amber-900 border border-amber-200 rounded-tl-sm'
                      : msg.role === 'user'
                      ? 'bg-orange-600 text-white rounded-tr-sm'
                      : 'bg-white text-neutral-800 rounded-tl-sm border border-neutral-200 shadow-sm'
                  }`}
                >
                  {msg.isSystem && (
                    <div className="flex items-center gap-2 mb-2 text-orange-500 font-medium text-sm">
                      {assets.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={assets.logoUrl} alt="Logo" className="w-4 h-4 rounded-full object-cover" />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      <span>CreaMype</span>
                    </div>
                  )}

                  {msg.text && (
                    <div className="prose prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-neutral-100 prose-pre:border prose-pre:border-neutral-200">
                      <ReactMarkdown>{msg.text}</ReactMarkdown>
                    </div>
                  )}

                  {msg.isImage && (msg.imageUrl || msg.imageAssetKey) && (
                    <div className="mt-3 rounded-lg overflow-hidden border border-neutral-200 bg-neutral-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={msg.imageAssetKey ? assets[msg.imageAssetKey] : msg.imageUrl} alt="Generated asset" className="w-full h-auto object-cover" />
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {isLoading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-start">
              <div className="bg-white border border-neutral-200 text-neutral-700 shadow-sm rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-3 text-sm">
                <Loader2 size={16} className="animate-spin text-orange-500" />
                <span>Pensando...</span>
              </div>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 bg-white border-t border-neutral-200">
          {mobileDeliverablePanel && (
            <div className="md:hidden mb-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
              {mobileDeliverablePanel}
            </div>
          )}
          {conversationNotFound && (
            <div role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p>No encontramos esta conversación.</p>
              <Link
                href="/"
                className="mt-2 inline-block rounded-lg border border-amber-300 px-3 py-2 font-medium hover:bg-amber-100"
              >
                Ir a mi última conversación
              </Link>
            </div>
          )}
          {liveConnectionLost && (
            <div role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p>{LIVE_CONNECTION_LOST_MESSAGE}</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-2 rounded-lg border border-amber-300 px-3 py-2 font-medium hover:bg-amber-100"
              >
                Recargar
              </button>
            </div>
          )}
          {conversationError && (
            <div role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {conversationError}
            </div>
          )}
          {retryTurn && (
            <div className="mb-3 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900">
              <p>Hay un turno anterior sin respuesta. Al continuar, se usará el mismo identificador para evitar duplicar la solicitud.</p>
              <button
                type="button"
                onClick={() => void submitTurn(retryTurn.userMessage, retryTurn.requestId)}
                disabled={isLoading}
                className="mt-2 rounded-lg border border-orange-300 px-3 py-2 font-medium hover:bg-orange-100 disabled:opacity-50"
              >
                Continuar este turno
              </button>
            </div>
          )}
          {needsNewConversation && (
            <p role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              No pudimos confirmar el resultado del turno anterior. No vuelvas a enviar ese mensaje; inicia una conversación nueva para continuar.
            </p>
          )}
          <div className="relative flex items-end gap-2">
            {labUpload && (
              <>
                <input
                  id="lab-report-input"
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  hidden
                  data-testid="lab-report-input"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (files.length > 0) labUpload.onFiles(files);
                  }}
                />
                <button
                  type="button"
                  title={LAB_UPLOAD_LABEL}
                  aria-label={LAB_UPLOAD_LABEL}
                  disabled={!conversationId || labUpload.busy || conversationNotFound}
                  onClick={() => document.getElementById('lab-report-input')?.click()}
                  className="mb-1 p-2 rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 flex-shrink-0"
                >
                  {labUpload.busy ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
                </button>
              </>
            )}
            {photoUpload && (
              <>
                <input
                  id="product-photo-input"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  multiple
                  hidden
                  data-testid="product-photo-input"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (files.length > 0) photoUpload.onFiles(files);
                  }}
                />
                <button
                  type="button"
                  title={PHOTO_UPLOAD_LABEL}
                  aria-label={PHOTO_UPLOAD_LABEL}
                  disabled={!conversationId || photoUpload.busy || conversationNotFound}
                  onClick={() => document.getElementById('product-photo-input')?.click()}
                  className="mb-1 p-2 rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 flex-shrink-0"
                >
                  {photoUpload.busy ? <Loader2 size={18} className="animate-spin" /> : <ImageIcon size={18} />}
                </button>
              </>
            )}
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribe tu mensaje aquí..."
              className="w-full bg-neutral-50 border border-neutral-200 text-neutral-900 rounded-xl px-4 py-3 pr-12 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500 resize-none min-h-[52px] max-h-32"
              rows={1}
              disabled={!conversationId || isLoading || Boolean(retryTurn) || needsNewConversation || conversationNotFound}
            />
            <button
              onClick={handleSend}
              disabled={!conversationId || !inputText.trim() || isLoading || Boolean(retryTurn) || needsNewConversation || conversationNotFound}
              className="absolute right-2 bottom-2 p-2 bg-orange-600 hover:bg-orange-500 disabled:bg-neutral-200 disabled:text-neutral-400 text-white rounded-lg transition-colors flex-shrink-0"
            >
              <Send size={18} />
            </button>
          </div>
          <p className="text-center text-[10px] text-neutral-500 mt-2">
            La IA puede cometer errores. Verifica la información importante.
          </p>
        </div>
      </div>


</>
  );
}
