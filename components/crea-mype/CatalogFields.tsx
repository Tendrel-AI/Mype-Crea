'use client';

import React from 'react';
import { MAX_COLORS, MAX_PRESENTATION_LABEL, MAX_PRESENTATIONS, MAX_PRICE_PEN, describeValue, type CatalogField, type Presentation } from '../../src/core/brand-catalog';

/** Form-side value of a field: text/money/choice are strings, the rest arrays. Converted by `toPayload`. */
export type FormValue = string | boolean | string[] | Presentation[];
export type FormValues = Record<string, FormValue>;

const inputClass = 'w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50';
const smallButton = 'rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50';

/** The empty form value for a field kind. */
export function emptyValue(field: CatalogField): FormValue {
  switch (field.kind) {
    case 'colors': case 'multichoice': return [];
    case 'presentations': return [{ label: '', principal: true }];
    default: return '';
  }
}

/** Stored attribute -> form value (money becomes its text). */
export function toFormValue(field: CatalogField, stored: unknown): FormValue {
  if (stored === undefined || stored === null) return emptyValue(field);
  if (field.kind === 'money') return String(stored);
  return stored as FormValue;
}

/** Form value -> attribute payload for the server. A money text that is not a plain number is sent as text so the server reports it. */
export function toPayloadValue(field: CatalogField, value: FormValue | undefined): unknown {
  if (field.kind === 'money') {
    const text = String(value ?? '').trim();
    if (text === '') return '';
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  return value;
}

interface FieldProps {
  field: CatalogField;
  id: string;
  value: FormValue;
  onChange: (value: FormValue) => void;
  error?: string;
  disabled?: boolean;
  /** The brand's value, shown as «Heredado de la marca: …» while this product field is empty. */
  inherited?: unknown;
}

const isEmpty = (value: FormValue) => Array.isArray(value) ? value.length === 0 : value === '';

function Colors({ id, value, onChange, disabled, label }: { id: string; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; label: string }) {
  const set = (index: number, hex: string) => onChange(value.map((c, i) => (i === index ? hex : c)));
  return (
    <div className="space-y-2">
      {value.map((hex, index) => (
        <div key={index} className="flex items-center gap-2">
          <input type="color" aria-label={`${label} ${index + 1}: selector`} value={/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000'} disabled={disabled}
            onChange={(e) => set(index, e.target.value.toUpperCase())} className="h-9 w-12 rounded border border-neutral-300" />
          <input id={index === 0 ? id : undefined} type="text" aria-label={`${label} ${index + 1}: código hexadecimal`} value={hex} maxLength={7} placeholder="#RRGGBB" disabled={disabled}
            onChange={(e) => set(index, e.target.value)} className={`${inputClass} max-w-[9rem] font-mono`} />
          <button type="button" className={smallButton} disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))}>Quitar</button>
        </div>
      ))}
      <button type="button" className={smallButton} disabled={disabled || value.length >= MAX_COLORS} onClick={() => onChange([...value, '#000000'])}>
        Agregar color
      </button>
    </div>
  );
}

function Presentations({ id, value, onChange, disabled }: { id: string; value: Presentation[]; onChange: (v: Presentation[]) => void; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      {value.map((item, index) => (
        <div key={index} className="flex items-center gap-2">
          <input id={index === 0 ? id : undefined} type="text" aria-label={`Presentación ${index + 1}`} value={item.label} maxLength={MAX_PRESENTATION_LABEL} placeholder="Ej.: 250 g" disabled={disabled}
            onChange={(e) => onChange(value.map((p, i) => (i === index ? { ...p, label: e.target.value } : p)))} className={inputClass} />
          <label className="flex items-center gap-1 whitespace-nowrap text-xs">
            <input type="radio" name={`${id}-principal`} checked={item.principal} disabled={disabled}
              onChange={() => onChange(value.map((p, i) => ({ ...p, principal: i === index })))} />
            Principal
          </label>
          <button type="button" className={smallButton} disabled={disabled || value.length <= 1}
            onClick={() => {
              const rest = value.filter((_, i) => i !== index);
              // Removing the principal one hands the role to the first remaining row.
              onChange(rest.some((p) => p.principal) ? rest : rest.map((p, i) => ({ ...p, principal: i === 0 })));
            }}>Quitar</button>
        </div>
      ))}
      <button type="button" className={smallButton} disabled={disabled || value.length >= MAX_PRESENTATIONS} onClick={() => onChange([...value, { label: '', principal: false }])}>
        Agregar presentación
      </button>
    </div>
  );
}

/** One labelled control per field kind, with its required mark, inherited hint and visible error. */
export function CatalogFieldControl({ field, id, value, onChange, error, disabled, inherited }: FieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const hint = field.overridesBrand && isEmpty(value) && inherited !== undefined && describeValue(inherited)
    ? `Heredado de la marca: ${describeValue(inherited)}` : '';
  const common = { id, disabled, 'aria-invalid': error ? true : undefined, 'aria-describedby': [error && errorId, hint && hintId].filter(Boolean).join(' ') || undefined };
  const grouped = field.kind === 'multichoice' || field.kind === 'colors' || field.kind === 'presentations';

  let control: React.ReactNode;
  switch (field.kind) {
    case 'text':
      control = <input {...common} type="text" maxLength={field.maxLength} value={value as string} placeholder={hint} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
      break;
    case 'longtext':
      control = <textarea {...common} rows={3} maxLength={field.maxLength} value={value as string} placeholder={hint} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
      break;
    case 'choice':
      control = (
        <select {...common} value={value as string} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          <option value="">Selecciona una opción</option>
          {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      );
      break;
    case 'money':
      control = <input {...common} type="number" inputMode="decimal" step="0.01" min={0} max={MAX_PRICE_PEN} value={value as string} onChange={(e) => onChange(e.target.value)} className={`${inputClass} max-w-[10rem]`} />;
      break;
    case 'multichoice': {
      const picked = value as string[];
      control = (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {field.options?.map((option) => (
            <label key={option} className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={picked.includes(option)} disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...picked, option] : picked.filter((o) => o !== option))} />
              {option}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'colors':
      control = <Colors id={id} label={field.label} value={value as string[]} onChange={onChange} disabled={disabled} />;
      break;
    case 'presentations':
      control = <Presentations id={id} value={value as Presentation[]} onChange={onChange} disabled={disabled} />;
      break;
  }

  const mark = field.required ? <span aria-hidden="true" className="text-red-600"> *</span> : null;
  const extra = (
    <>
      {hint && grouped && <p id={hintId} className="mt-1 text-xs text-neutral-500">{hint}</p>}
      {hint && !grouped && <p id={hintId} className="sr-only">{hint}</p>}
      {error && <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-red-700">{error}</p>}
    </>
  );
  return grouped ? (
    <fieldset className="space-y-1" aria-describedby={common['aria-describedby']}>
      <legend className="text-sm font-medium text-neutral-800">{field.label}{mark}{field.required && <span className="sr-only"> (obligatorio)</span>}</legend>
      {control}
      {extra}
    </fieldset>
  ) : (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-neutral-800">{field.label}{mark}{field.required && <span className="sr-only"> (obligatorio)</span>}</label>
      {control}
      {extra}
    </div>
  );
}
