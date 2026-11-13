'use client';

import React, { useId, useRef, useState } from 'react';
import { validateAttributes, type AttributeLevel, type CatalogField } from '../../src/core/brand-catalog';
import { CatalogFieldControl, emptyValue, toFormValue, toPayloadValue, type FormValue, type FormValues } from './CatalogFields';

export type FormResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly fieldErrors?: Record<string, string> };

export const GENERIC_FORM_ERROR = 'No pudimos guardar los datos. Inténtalo de nuevo.';

export interface FormContext {
  values: FormValues;
  setValue: (key: string, value: FormValue) => void;
  busy: boolean;
}

export interface SubmitOutcome {
  readonly errors: Record<string, string>;
  readonly formError: string;
  /** False when the local mirror stopped it (nothing was sent). */
  readonly sent: boolean;
  readonly ok: boolean;
}

/**
 * One submit attempt as a pure async step: build the payload, mirror the server validation for quick
 * feedback (nothing is sent when it fails), send, and turn the SERVER verdict into per-field errors.
 */
export async function runSubmit(
  level: AttributeLevel,
  fields: ReadonlyArray<CatalogField>,
  values: FormValues,
  onSubmit: (payload: Record<string, unknown>) => Promise<FormResult>,
): Promise<SubmitOutcome> {
  const payload: Record<string, unknown> = Object.fromEntries(fields.map((f) => [f.key, toPayloadValue(f, values[f.key])]));
  if (level === 'brand') payload.name_pending = values.name_pending === true;
  const local = validateAttributes(level, payload, { partial: false });
  if (!local.ok) {
    return { errors: local.errors, formError: local.errors._form ?? 'Revisa los campos marcados.', sent: false, ok: false };
  }
  try {
    const result = await onSubmit(payload);
    if (result.ok) return { errors: {}, formError: '', sent: true, ok: true };
    return { errors: result.fieldErrors ?? {}, formError: result.fieldErrors?._form ?? (result.message || GENERIC_FORM_ERROR), sent: true, ok: false };
  } catch (error) {
    console.error('Form submit failed.', error);
    return { errors: {}, formError: GENERIC_FORM_ERROR, sent: true, ok: false };
  }
}

/** The form's markup for a given state; errors are always rendered next to their field and in an alert. */
export function CatalogFormView({
  prefix, fields, values, errors, formError, busy, inherited, submitLabel, onChange, onSubmit, onCancel, renderAfter, isDisabled, children,
}: {
  prefix: string;
  fields: ReadonlyArray<CatalogField>;
  values: FormValues;
  errors: Record<string, string>;
  formError: string;
  busy: boolean;
  inherited?: Record<string, unknown>;
  submitLabel: string;
  onChange: (key: string, value: FormValue) => void;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
  renderAfter?: (key: string, ctx: FormContext) => React.ReactNode;
  isDisabled?: (key: string, values: FormValues) => boolean;
  children?: React.ReactNode | ((ctx: FormContext) => React.ReactNode);
}) {
  const ctx: FormContext = { values, setValue: onChange, busy };
  const unknownKeys = Object.keys(errors).filter((key) => key !== '_form' && !fields.some((f) => f.key === key));
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {fields.map((field) => (
        <React.Fragment key={field.key}>
          <CatalogFieldControl
            field={field}
            id={`${prefix}-${field.key}`}
            value={values[field.key]}
            onChange={(value) => onChange(field.key, value)}
            error={errors[field.key]}
            disabled={busy || isDisabled?.(field.key, values)}
            inherited={inherited?.[field.key]}
          />
          {renderAfter?.(field.key, ctx)}
        </React.Fragment>
      ))}
      {typeof children === 'function' ? children(ctx) : children}
      {unknownKeys.map((key) => <p key={key} role="alert" className="text-xs font-medium text-red-700">{errors[key]}</p>)}
      {formError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{formError}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50">Cancelar</button>
        <button type="submit" disabled={busy} aria-busy={busy} className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 dark:hover:bg-orange-500 disabled:opacity-60">
          {busy ? 'Guardando…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * The shared engine of the brand and product forms: renders the catalog fields, mirrors the server
 * validation to give quick feedback, and sends the payload. The SERVER verdict is the only gate:
 * its per-field errors are shown next to the fields, and the form never closes on its own.
 */
export function CatalogForm({
  level, fields, initialValues, inherited, submitLabel, onSubmit, onCancel, renderAfter, isDisabled, children,
}: {
  level: AttributeLevel;
  fields: ReadonlyArray<CatalogField>;
  /** Stored attributes (edit) or empty. `name_pending` lives here too. */
  initialValues?: Record<string, unknown>;
  inherited?: Record<string, unknown>;
  submitLabel: string;
  onSubmit: (payload: Record<string, unknown>) => Promise<FormResult>;
  onCancel: () => void;
  /** Extra controls rendered right after a field (e.g. the «Aún no tengo nombre» checkbox). */
  renderAfter?: (key: string, ctx: FormContext) => React.ReactNode;
  isDisabled?: (key: string, values: FormValues) => boolean;
  /** Extra sections after the fields (e.g. file uploads). */
  children?: React.ReactNode | ((ctx: FormContext) => React.ReactNode);
}) {
  const prefix = useId();
  const [values, setValues] = useState<FormValues>(() => ({
    ...(initialValues?.name_pending === true ? { name_pending: true } : {}),
    ...Object.fromEntries(fields.map((f) => [f.key, initialValues?.[f.key] === undefined ? emptyValue(f) : toFormValue(f, initialValues[f.key])])),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  const onChange = (key: string, value: FormValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => { const { [key]: _gone, ...rest } = prev; return rest; });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFormError('');
    try {
      const outcome = await runSubmit(level, fields, values, onSubmit);
      setErrors(outcome.errors);
      setFormError(outcome.formError);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <CatalogFormView
      prefix={prefix} fields={fields} values={values} errors={errors} formError={formError} busy={busy} inherited={inherited}
      submitLabel={submitLabel} onChange={onChange} onSubmit={submit} onCancel={onCancel} renderAfter={renderAfter} isDisabled={isDisabled}
    >
      {children}
    </CatalogFormView>
  );
}
