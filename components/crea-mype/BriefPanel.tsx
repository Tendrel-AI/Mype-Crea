'use client';

/**
 * Brief panel (KAN-26): every catalog field with its accepted value, whether
 * it still needs confirmation, and the channel that wrote it. The user edits
 * one field inline; «Guardar» and «Confirmar» call the server, which
 * validates the value and merges it through the same path as the chat. The
 * panel shows only what the server returns.
 */

import React, { useState } from 'react';
import { Check, Loader2, Pencil } from 'lucide-react';
import type { BriefPanelField } from '../../app/actions/brief';

const ORIGIN_LABELS = { brand: 'De la marca', product: 'Del producto' } as const;
const SOURCE_LABELS = { chat: 'Del chat', panel: 'Editado aquí' } as const;

export function BriefPanel({
  fields,
  savingField,
  error,
  onSave,
}: {
  fields: ReadonlyArray<BriefPanelField>;
  /** Field whose save is in flight; every edit control is disabled meanwhile. */
  savingField: string | null;
  error: { readonly field: string; readonly message: string } | null;
  /** Resolves true when the server accepted the value. */
  onSave: (fieldName: string, value: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const busy = savingField !== null;
  const buttonBase =
    'inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  if (fields.length === 0) return null;

  return (
    <dl className="divide-y divide-neutral-100" data-testid="brief-panel">
      {fields.map((field) => {
        const inputId = `brief-${field.name}`;
        const isEditing = editing === field.name;
        const pending = field.status === 'pending_confirmation';
        return (
          <div key={field.name} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-3">
            <dt className="shrink-0 text-xs font-medium text-neutral-500 sm:w-32 sm:pt-1">
              {isEditing ? <label htmlFor={inputId}>{field.label}</label> : field.label}
            </dt>
            <dd className="min-w-0 flex-1">
              {isEditing ? (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onSave(field.name, draft).then((saved) => {
                      if (saved) setEditing(null);
                    });
                  }}
                >
                  {field.maxLength > 200 ? (
                    <textarea
                      id={inputId}
                      value={draft}
                      maxLength={field.maxLength}
                      rows={3}
                      onChange={(event) => setDraft(event.target.value)}
                      className="w-full resize-none rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                    />
                  ) : (
                    <input
                      id={inputId}
                      value={draft}
                      maxLength={field.maxLength}
                      onChange={(event) => setDraft(event.target.value)}
                      className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                    />
                  )}
                  {field.origin === 'brand' && (
                    <p className="text-xs text-neutral-500">Se guarda en la marca para todos sus productos</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className={`${buttonBase} text-neutral-600 hover:bg-neutral-100`}
                    >
                      Cancelar
                    </button>
                    <button type="submit" disabled={busy} className={`${buttonBase} bg-orange-600 text-white hover:bg-orange-500`}>
                      {savingField === field.name && <Loader2 size={12} className="animate-spin" />} Guardar
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`min-w-0 break-words text-sm ${field.value === null ? 'text-neutral-400' : 'text-neutral-900'}`}>
                    {field.value ?? 'Sin completar'}
                  </span>
                  {pending && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                      Por confirmar
                    </span>
                  )}
                  {field.origin !== 'conversation' && (
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-800">{ORIGIN_LABELS[field.origin]}</span>
                  )}
                  {field.source && (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">
                      {SOURCE_LABELS[field.source]}
                    </span>
                  )}
                  <span className="ml-auto flex gap-1">
                    {pending && field.value !== null && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onSave(field.name, field.value!)}
                        className={`${buttonBase} border border-emerald-300 text-emerald-700 hover:bg-emerald-50`}
                      >
                        <Check size={12} /> Confirmar
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Editar ${field.label}`}
                      onClick={() => {
                        setDraft(field.value ?? '');
                        setEditing(field.name);
                      }}
                      className={`${buttonBase} border border-neutral-200 text-neutral-700 hover:bg-neutral-100`}
                    >
                      <Pencil size={12} /> Editar
                    </button>
                  </span>
                </div>
              )}
              {error?.field === field.name && (
                <p role="alert" className="mt-1 text-xs text-red-700">
                  {error.message}
                </p>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
