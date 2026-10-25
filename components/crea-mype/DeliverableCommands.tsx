'use client';

/**
 * Deliverable command panel (KAN-28 / KAN-64 / KAN-65).
 *
 * Renders one deliverable's server-derived state: a Spanish state badge, the
 * «Obsoleto» overlay, its candidates (with Aprobar / «Aprobada»), and the
 * command buttons listed in `allowedCommands`. The buttons are advisory: the
 * server re-validates every command against a fresh state.
 *
 * «Avanzar» is UI navigation only (scrolls to the next section); it never
 * reaches the server.
 */

import React, { useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Sparkles, Wand2, XCircle, ArrowRight } from 'lucide-react';
import type { DeliverableCommandKind, DeliverableStateKind, DeliverableStateView } from '../../src/core/contracts';

/** Mirrors MAX_ITERATION_OBSERVATION_LENGTH; the server enforces it in code points. */
export const OBSERVATION_MAX_LENGTH = 500;

export type DeliverableCommandRequest =
  | { readonly kind: 'generate' }
  | { readonly kind: 'iterate'; readonly deliverableId: string | null; readonly observation: string }
  | { readonly kind: 'approve'; readonly deliverableId: string }
  | { readonly kind: 'retry' }
  | { readonly kind: 'cancel' };

export const STATE_LABELS: Readonly<Record<DeliverableStateKind, string>> = {
  blocked: 'Bloqueado',
  enabled: 'Listo para generar',
  generating: 'Generando',
  in_review: 'En revisión',
  approved: 'Aprobado',
  failed: 'Falló',
};

const STATE_STYLES: Readonly<Record<DeliverableStateKind, string>> = {
  blocked: 'bg-neutral-100 text-neutral-600',
  enabled: 'bg-orange-50 text-orange-700',
  generating: 'bg-orange-50 text-orange-700',
  in_review: 'bg-sky-50 text-sky-700',
  approved: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
};

const has = (view: DeliverableStateView, command: DeliverableCommandKind) => view.allowedCommands.includes(command);

function codePoints(value: string): number {
  return [...value].length;
}

export function DeliverableCommands({
  view,
  label,
  busy,
  error,
  onCommand,
  onAdvance,
}: {
  view: DeliverableStateView | undefined;
  /** Lowercase noun for copy, e.g. "logo". */
  label: string;
  busy: boolean;
  error: string;
  onCommand: (request: DeliverableCommandRequest) => void;
  /** UI-only navigation to the next section. Omit to hide «Avanzar». */
  onAdvance?: () => void;
}) {
  const [iterating, setIterating] = useState(false);
  const [observation, setObservation] = useState('');

  if (!view) return null;

  const anchorId = view.approvedDeliverableId ?? view.candidates.at(-1)?.deliverableId ?? null;
  const tooLong = codePoints(observation.trim()) > OBSERVATION_MAX_LENGTH;
  const buttonBase =
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="mt-4 space-y-3" data-testid={`deliverable-commands-${view.agentId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATE_STYLES[view.state]}`}>
          {view.state === 'generating' && <Loader2 size={12} className="mr-1 inline animate-spin" />}
          {STATE_LABELS[view.state]}
        </span>
        {view.stale && (
          <span
            className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800"
            title="Cambió algo de lo que este entregable depende. Puedes generarlo de nuevo."
          >
            Obsoleto
          </span>
        )}
      </div>

      {view.state === 'blocked' && (
        <p className="text-xs text-neutral-500">
          {view.missingUpstream.length > 0
            ? 'Primero aprueba los entregables anteriores.'
            : `Completa la información en el chat para habilitar tu ${label}.`}
        </p>
      )}
      {view.state === 'enabled' && (
        <p className="text-xs text-neutral-500">Ya tienes todo listo. Toca Generar cuando quieras.</p>
      )}
      {view.state === 'failed' && (
        <p role="status" className="text-xs text-red-700">
          {view.lastFailure?.retryable
            ? 'La generación falló por un problema temporal. Puedes reintentar.'
            : `No pudimos generar tu ${label}. Revisa la información en el chat o inicia un producto nuevo.`}
        </p>
      )}
      {view.stale && (
        <p className="text-xs text-amber-800">
          Cambió algo de lo que depende este {label}. Puedes generarlo de nuevo o mantener el aprobado.
        </p>
      )}

      {view.candidates.length > 0 && (
        <ul className="grid grid-cols-3 gap-2" aria-label="Propuestas">
          {view.candidates.map((candidate, index) => {
            const isApproved = candidate.deliverableId === view.approvedDeliverableId;
            return (
              <li
                key={candidate.deliverableId}
                className={`flex flex-col gap-1 rounded-lg border p-1 ${isApproved ? 'border-emerald-500' : 'border-neutral-200'}`}
              >
                {candidate.contentUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={candidate.contentUrl}
                    alt={`Propuesta ${index + 1}`}
                    className="aspect-square w-full rounded object-cover"
                  />
                ) : (
                  <span className="text-xs text-neutral-500">Propuesta {index + 1}</span>
                )}
                {isApproved ? (
                  <span className="inline-flex items-center justify-center gap-1 text-[11px] font-medium text-emerald-700">
                    <CheckCircle2 size={12} /> Aprobada
                  </span>
                ) : (
                  has(view, 'approve') && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onCommand({ kind: 'approve', deliverableId: candidate.deliverableId })}
                      className={`${buttonBase} justify-center bg-emerald-600 text-white hover:bg-emerald-500`}
                    >
                      Aprobar
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {has(view, 'generate') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onCommand({ kind: 'generate' })}
            className={`${buttonBase} bg-orange-600 text-white hover:bg-orange-500`}
          >
            <Sparkles size={14} /> Generar
          </button>
        )}
        {has(view, 'iterate') && !iterating && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setIterating(true)}
            className={`${buttonBase} border border-orange-300 text-orange-700 hover:bg-orange-50`}
          >
            <Wand2 size={14} /> Iterar
          </button>
        )}
        {has(view, 'retry') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onCommand({ kind: 'retry' })}
            className={`${buttonBase} bg-orange-600 text-white hover:bg-orange-500`}
          >
            <RefreshCw size={14} /> Reintentar
          </button>
        )}
        {has(view, 'cancel') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onCommand({ kind: 'cancel' })}
            className={`${buttonBase} border border-neutral-300 text-neutral-700 hover:bg-neutral-100`}
          >
            <XCircle size={14} /> Cancelar
          </button>
        )}
        {view.state === 'approved' && onAdvance && (
          <button
            type="button"
            onClick={onAdvance}
            className={`${buttonBase} border border-neutral-300 text-neutral-700 hover:bg-neutral-100`}
          >
            Avanzar <ArrowRight size={14} />
          </button>
        )}
      </div>

      {iterating && has(view, 'iterate') && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (tooLong) return;
            onCommand({ kind: 'iterate', deliverableId: anchorId, observation: observation.trim() });
            setObservation('');
            setIterating(false);
          }}
        >
          <label className="block text-xs font-medium text-neutral-700" htmlFor={`iterate-${view.agentId}`}>
            ¿Qué quieres cambiar de esta propuesta?
          </label>
          <textarea
            id={`iterate-${view.agentId}`}
            value={observation}
            maxLength={OBSERVATION_MAX_LENGTH}
            onChange={(event) => setObservation(event.target.value)}
            placeholder="Por ejemplo: usa colores más cálidos y una letra más gruesa."
            rows={3}
            className="w-full resize-none rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/50"
          />
          <div className="flex items-center justify-between">
            <span className={`text-[11px] ${tooLong ? 'text-red-700' : 'text-neutral-500'}`}>
              {codePoints(observation.trim())}/{OBSERVATION_MAX_LENGTH}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setIterating(false);
                  setObservation('');
                }}
                className={`${buttonBase} text-neutral-600 hover:bg-neutral-100`}
              >
                Descartar
              </button>
              <button
                type="submit"
                disabled={busy || tooLong}
                className={`${buttonBase} bg-orange-600 text-white hover:bg-orange-500`}
              >
                Enviar
              </button>
            </div>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {error}
        </p>
      )}
    </div>
  );
}
