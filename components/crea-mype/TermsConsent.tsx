'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { acceptTermsAction } from '../../app/actions/terms';
import type { TermsDocument } from '../../src/consent/terms';

/**
 * KAN-27: shown instead of the wizard until the user accepts the current terms. The checkbox
 * only enables the button; acceptance is the explicit `acceptTermsAction` call, which the server
 * validates and records. After it, the page re-renders server-side and opens the chat.
 */
export function TermsConsent({ terms }: { readonly terms: TermsDocument }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const accept = async () => {
    setSubmitting(true);
    setError('');
    try {
      const result = await acceptTermsAction({ termsVersion: terms.version, accepted: true });
      if (result.ok) {
        router.refresh();
        return;
      }
      setError(result.message);
    } catch {
      setError('No pudimos registrar tu aceptación. Inténtalo de nuevo.');
    }
    setSubmitting(false);
  };

  return (
    <main className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
      <section
        aria-labelledby="terms-title"
        className="bg-white rounded-2xl p-6 max-w-2xl w-full shadow-xl border border-neutral-200"
      >
        <h1 id="terms-title" className="text-xl font-bold text-neutral-900 mb-2">{terms.title}</h1>
        <p className="text-neutral-600 text-sm mb-4">{terms.intro}</p>
        <div className="max-h-[50vh] overflow-y-auto space-y-4 pr-2 mb-4" tabIndex={0}>
          {terms.sections.map((section) => (
            <div key={section.heading}>
              <h2 className="text-sm font-semibold text-neutral-900 mb-1">{section.heading}</h2>
              <p className="text-sm text-neutral-700">{section.body}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-neutral-500 mb-4">Versión: {terms.version}</p>
        <label className="flex items-start gap-2 text-sm text-neutral-800 mb-4">
          <input
            type="checkbox"
            className="mt-1"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          <span>He leído los términos y acepto el tratamiento de mis datos personales como se describe aquí.</span>
        </label>
        {error && <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={accept}
            disabled={!checked || submitting}
            className="px-4 py-2 text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 dark:hover:bg-orange-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Guardando…' : 'Aceptar y continuar'}
          </button>
        </div>
      </section>
    </main>
  );
}
