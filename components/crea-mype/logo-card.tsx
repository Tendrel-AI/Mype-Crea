'use client';

/** Logo box of a brand chat (D62): the owner's reference images (upload, thumbnails, remove) and the deliverable commands. */

import React from 'react';
import { DeliverableCommands } from './DeliverableCommands';

export const LOGO_REFERENCE_LABEL = 'Subir referencia';
/** Mirrors `MAX_LOGO_REFERENCES` (src/logo/refs.ts); the UI never imports from `src/logo`. */
export const MAX_LOGO_REFERENCES = 3;
export const LOGO_REFERENCE_ACCEPT = 'image/png,image/jpeg,image/webp';

export function LogoCard({
  references,
  uploading,
  onUpload,
  onRemove,
  ...commands
}: {
  /** The brand's uploaded reference images (id and original name). */
  references: ReadonlyArray<{ id: string; name: string }>;
  uploading: boolean;
  onUpload: (files: File[]) => void;
  onRemove: (fileId: string) => void;
} & React.ComponentProps<typeof DeliverableCommands>) {
  const full = references.length >= MAX_LOGO_REFERENCES;
  return (
    <section aria-label="Referencias del logo">
      <p className="text-xs text-neutral-500">
        Si quieres, sube hasta {MAX_LOGO_REFERENCES} imágenes (PNG, JPG o WebP, máximo 5 MB) para que el logo siga su estilo.
      </p>
      {references.length > 0 && (
        <ul className="mt-2 flex gap-2" data-testid="logo-reference-thumbs">
          {references.map(({ id, name }) => (
            <li key={id} className="relative h-14 w-14">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/brand-files/${id}`} alt={name} className="h-14 w-14 rounded-md border border-neutral-200 object-cover" />
              <button
                type="button"
                aria-label={`Quitar referencia ${name}`}
                disabled={commands.busy || uploading}
                onClick={() => onRemove(id)}
                className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-neutral-800 text-xs leading-5 text-white disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id="logo-reference-input"
        type="file"
        accept={LOGO_REFERENCE_ACCEPT}
        multiple
        hidden
        data-testid="logo-reference-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) onUpload(files);
        }}
      />
      <button
        type="button"
        disabled={full || uploading || commands.busy}
        onClick={() => document.getElementById('logo-reference-input')?.click()}
        className="mt-2 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
      >
        {LOGO_REFERENCE_LABEL}
      </button>
      {uploading && <p role="status" className="mt-2 text-xs text-neutral-500">Subiendo la referencia…</p>}
      <DeliverableCommands {...commands} />
    </section>
  );
}
