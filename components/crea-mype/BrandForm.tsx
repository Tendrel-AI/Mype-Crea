'use client';

import React, { useState } from 'react';
import { BRAND_CATALOG, MAX_BRAND_ASSETS as MAX_ASSETS } from '../../src/core/brand-catalog';
import type { BrandFileView } from '../../src/conversations/selection';
import { CatalogForm, type FormResult } from './CatalogForm';

export type BrandFormMode = 'create' | 'import' | 'edit';

export interface BrandFiles { readonly logo: File | null; readonly assets: ReadonlyArray<File> }

/** The data was saved but some files were not uploaded: the form stays open and lists them next to the file field. */
export type BrandFormResult =
  | FormResult
  | { readonly ok: false; readonly message: string; readonly uploadErrors: ReadonlyArray<string>; readonly remaining: BrandFiles };

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';
/** Only «Ya tengo una marca» (and editing) shows these; «Crear marca» starts from nothing. */
const IMPORT_ONLY = new Set(['existing_tagline', 'social_accounts']);

const TITLES: Record<BrandFormMode, string> = { create: 'Crear marca', import: 'Ya tengo una marca', edit: 'Editar marca' };

export function FileInputs({ existing, files, onChange, disabled, uploadErrors = [] }: {
  existing: ReadonlyArray<BrandFileView>; files: BrandFiles; onChange: (files: BrandFiles) => void; disabled: boolean; uploadErrors?: ReadonlyArray<string>;
}) {
  const [error, setError] = useState('');
  const storedAssets = existing.filter((f) => f.kind === 'asset').length;
  const pick = (list: FileList | null, many: boolean) => {
    const picked = Array.from(list ?? []);
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) { setError(`«${tooBig.name}» supera los 5 MB.`); return null; }
    if (many && storedAssets + picked.length > MAX_ASSETS) { setError(`Puedes tener hasta ${MAX_ASSETS} archivos de apoyo.`); return null; }
    setError('');
    return picked;
  };
  return (
    <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-3">
      <legend className="px-1 text-sm font-medium text-neutral-800">Logo y archivos</legend>
      <div>
        <label htmlFor="brand-logo" className="block text-sm font-medium text-neutral-800">Logo (PNG, JPG, WebP o SVG, hasta 5 MB)</label>
        <input id="brand-logo" type="file" accept={IMAGE_ACCEPT} disabled={disabled} className="text-sm"
          onChange={(e) => { const picked = pick(e.target.files, false); if (picked) onChange({ ...files, logo: picked[0] ?? null }); }} />
        {existing.filter((f) => f.kind === 'logo').map((f) => (
          <p key={f.id} className="text-xs text-neutral-600">Logo actual: <a href={f.url} target="_blank" rel="noreferrer" className="underline">{f.originalName}</a>. Si subes otro, lo reemplaza.</p>
        ))}
      </div>
      <div>
        <label htmlFor="brand-assets" className="block text-sm font-medium text-neutral-800">Archivos de apoyo (hasta {MAX_ASSETS})</label>
        <input id="brand-assets" type="file" multiple accept={IMAGE_ACCEPT} disabled={disabled} className="text-sm"
          onChange={(e) => { const picked = pick(e.target.files, true); if (picked) onChange({ ...files, assets: picked }); }} />
        <ul className="text-xs text-neutral-600">
          {existing.filter((f) => f.kind === 'asset').map((f) => (
            <li key={f.id}><a href={f.url} target="_blank" rel="noreferrer" className="underline">{f.originalName}</a></li>
          ))}
        </ul>
      </div>
      {error && <p role="alert" className="text-xs font-medium text-red-700">{error}</p>}
      {uploadErrors.map((message) => <p key={message} role="alert" className="text-xs font-medium text-red-700">{message}</p>)}
      {files.logo || files.assets.length > 0 ? <p className="text-xs text-neutral-600">Pendientes de subir: {[files.logo?.name, ...files.assets.map((f) => f.name)].filter(Boolean).join(', ')}</p> : null}
    </fieldset>
  );
}

/** «Crear marca», «Ya tengo una marca» and «Editar marca»: the brand catalog as a form. */
export function BrandForm({ mode, initialValues, existingFiles = [], onSubmit, onCancel }: {
  mode: BrandFormMode;
  initialValues?: Record<string, unknown>;
  existingFiles?: ReadonlyArray<BrandFileView>;
  onSubmit: (attributes: Record<string, unknown>, files: BrandFiles) => Promise<BrandFormResult>;
  onCancel: () => void;
}) {
  const [files, setFiles] = useState<BrandFiles>({ logo: null, assets: [] });
  const [uploadErrors, setUploadErrors] = useState<ReadonlyArray<string>>([]);
  const fields = BRAND_CATALOG.filter((f) => mode !== 'create' || !IMPORT_ONLY.has(f.key));
  return (
    <CatalogForm
      level="brand"
      fields={fields}
      initialValues={initialValues}
      submitLabel={mode === 'edit' ? 'Guardar cambios' : 'Crear marca'}
      onSubmit={async (attributes) => {
        const result = await onSubmit(attributes, files);
        if (result.ok) return result;
        if ('uploadErrors' in result) {
          setUploadErrors(result.uploadErrors);
          setFiles(result.remaining);
          return { ok: false, message: result.message };
        }
        setUploadErrors([]);
        return result;
      }}
      onCancel={onCancel}
      isDisabled={(key, values) => key === 'business_name' && values.name_pending === true}
      renderAfter={(key, { values, setValue, busy }) => key === 'business_name' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={values.name_pending === true} disabled={busy} onChange={(e) => setValue('name_pending', e.target.checked)} />
          Aún no tengo nombre
        </label>
      )}
    >
      {mode !== 'create' && <FileInputs existing={existingFiles} files={files} onChange={setFiles} disabled={false} uploadErrors={uploadErrors} />}
    </CatalogForm>
  );
}

export const brandFormTitle = (mode: BrandFormMode) => TITLES[mode];
