'use client';

/**
 * Deliverable command panel (KAN-28 / KAN-64 / KAN-65).
 *
 * Renders one deliverable's server-derived state: a Spanish state badge, the
 * «Potencialmente desactualizado» overlay (RF-07), its candidates (with Aprobar / «Aprobada»; a
 * candidate that did not pass the safety check shows the KAN-33 review message instead), and the
 * command buttons listed in `allowedCommands`. KAN-29: each candidate also shows its iteration,
 * its own staleness, and a «Detalles» disclosure with its recorded provenance. The buttons are advisory: the
 * server re-validates every command against a fresh state.
 *
 * «Avanzar» is UI navigation only (scrolls to the next section); it never
 * reaches the server.
 */

import React, { useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Sparkles, Wand2, XCircle, ArrowRight, ThumbsUp, ThumbsDown, UserCheck } from 'lucide-react';
import type { DeliverableCommandKind, DeliverableStateKind, DeliverableStateView } from '../../src/core/contracts';
import { failedCardMessage } from './failure-copy';
import { briefFieldSpec } from '../../src/core/brief';
import type { FeedbackValue } from '../../src/repos/deliverable-feedback';

/** Owner decision 2026-11-02 (KAN-31): shown on every set of name candidates. No availability claims. */
export const NAME_AVAILABILITY_NOTE = 'Verifica la disponibilidad del nombre en INDECOPI antes de usarlo.';

/** Mirrors OWN_TEXT_MAX_LENGTH (the server enforces it in code points). */
export const OWN_TEXT_MAX_LENGTH = 120;

/** Mirrors MAX_ITERATION_OBSERVATION_LENGTH; the server enforces it in code points. */
export const OBSERVATION_MAX_LENGTH = 500;

export type DeliverableCommandRequest =
  | { readonly kind: 'generate' }
  | { readonly kind: 'iterate'; readonly deliverableId: string | null; readonly observation: string }
  | { readonly kind: 'approve'; readonly deliverableId: string }
  | { readonly kind: 'use_own'; readonly value?: string }
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

/** «Usar mi …» (F12 / KAN-89): the button of each brand-level kind; only the logo takes no text (it uses the uploaded one). */
export const USE_OWN_LABELS: Readonly<Record<string, string>> = {
  business_name: 'Usar mi nombre',
  logo: 'Usar mi logo',
  tagline: 'Usar mi lema',
};

/** KAN-89: shown on a brand-level deliverable inside a product conversation. */
export function inheritedFromBrandNotice(label: string, approved: boolean): string {
  return approved
    ? `Este ${label} es el aprobado de tu marca. Para cambiarlo, hazlo en el chat de la marca.`
    : `Tu ${label} se completa en el chat de tu marca. Cuando lo apruebes allí, aparecerá aquí.`;
}

/** RF-07 (KAN-35) overlay badge. */
export const STALE_LABEL = 'Potencialmente desactualizado';

/** RF-07 notice: something this deliverable used changed; nothing is regenerated on its own. */
export function staleNotice(view: Pick<DeliverableStateView, 'state'>, label: string): string {
  const keep = view.state === 'approved' ? ' o mantener el aprobado' : '';
  return `Cambió algo que usó este ${label} (un dato de tu marca o un entregable aprobado). No lo regeneramos solo: toca Iterar o Generar si quieres actualizarlo${keep}.`;
}

/** KAN-33 review path: shown instead of a candidate whose safety verdict is not `passed`. */
export function safetyReviewNotice(label: string): string {
  return `Este ${label} no pasó la revisión automática de seguridad. Genera otra opción.`;
}

/** Spanish nouns of deliverable kinds: the blocked message (KAN-32) and the details' type (KAN-29). */
const KIND_LABELS: Readonly<Record<string, string>> = {
  business_name: 'nombre comercial',
  logo: 'logo',
  tagline: 'lema',
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Blocked by an unapproved upstream: name it when every missing kind has a label. */
export function missingUpstreamMessage(kinds: ReadonlyArray<string>): string {
  const labels = kinds.map((kind) => KIND_LABELS[kind]);
  return labels.every(Boolean) ? `Primero aprueba tu ${labels.join(' y ')}.` : 'Primero aprueba los entregables anteriores.';
}

/** Spanish labels of the server's missing preconditions (KAN-26). */
function missingLabels(fields: ReadonlyArray<string>): string {
  return fields.map((name) => briefFieldSpec(name)?.label ?? name).join(', ');
}

const has = (view: DeliverableStateView, command: DeliverableCommandKind) => view.allowedCommands.includes(command);

function codePoints(value: string): number {
  return [...value].length;
}

/**
 * The Iterar request for `observation`, or null when it cannot be sent.
 * A failed deliverable's Iterar changes the failed request (KAN-58): it has
 * no anchor candidate and needs an observation (an unchanged request is a
 * Reintentar). Otherwise the anchor is the approved or newest candidate.
 */
export function iterateSubmission(
  view: Pick<DeliverableStateView, 'state' | 'approvedDeliverableId' | 'candidates'>,
  observation: string,
): Extract<DeliverableCommandRequest, { kind: 'iterate' }> | null {
  const trimmed = observation.trim();
  if (codePoints(trimmed) > OBSERVATION_MAX_LENGTH) return null;
  if (view.state === 'failed') {
    return trimmed.length === 0 ? null : { kind: 'iterate', deliverableId: null, observation: trimmed };
  }
  const anchorId = view.approvedDeliverableId ?? view.candidates.at(-1)?.deliverableId ?? null;
  return { kind: 'iterate', deliverableId: anchorId, observation: trimmed };
}

/**
 * A text candidate (KAN-31 names): the inline value and the one-line
 * rationale the agent stored in its metadata. Null for image candidates.
 */
export function textCandidate(
  candidate: DeliverableStateView['candidates'][number],
): { readonly text: string; readonly rationale: string | null } | null {
  const inline = candidate.contentInline;
  if (candidate.contentUrl || typeof inline?.value !== 'string') return null;
  const metadata = inline.metadata as Readonly<Record<string, unknown>> | undefined;
  return { text: inline.value, rationale: typeof metadata?.rationale === 'string' ? metadata.rationale : null };
}

type Candidate = DeliverableStateView['candidates'][number];

/** Per-candidate line (KAN-29): its iteration within the type and whether it is the approved one. */
export function candidateStatusLine(candidate: Pick<Candidate, 'iteration'>, isApproved: boolean): string {
  const status = isApproved ? 'Aprobada' : 'Lista';
  return candidate.iteration === null ? status : `Iteración ${candidate.iteration} · ${status}`;
}

/** Generation time in the pilot's time zone; fixed so every viewer reads the same value. */
export function formatGeneratedAt(iso: string): string {
  return new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(iso));
}

/** «Detalles» rows (KAN-29): type, time, model, versions, recorded inputs and approved upstreams. */
export function provenanceRows(deliverableKind: string, candidate: Pick<Candidate, 'createdAt' | 'provenance'>): ReadonlyArray<readonly [string, string]> {
  const { provenance } = candidate;
  const model = [provenance.provider, provenance.model].filter(Boolean).join(' · ');
  const inputs = provenance.inputs.map((input) => `${briefFieldSpec(input.field)?.label ?? input.field}: ${input.value}`).join('; ');
  return [
    ['Tipo', capitalize(KIND_LABELS[deliverableKind] ?? deliverableKind)],
    ...(provenance.origin === 'user' ? [['Origen', 'Lo aportaste tú, sin generación'] as const] : []),
    ['Generado', formatGeneratedAt(candidate.createdAt)],
    ['Modelo', model || 'No registrado'],
    ['Versión del prompt', provenance.promptVersion ?? 'No registrada'],
    ['Versión del agente', provenance.agentCardVersion ?? 'No registrada'],
    ['Datos usados', inputs || 'No registrados'],
    ...provenance.upstream.map(
      (up) => [`${capitalize(KIND_LABELS[up.kind] ?? up.kind)} aprobado que usó`, up.value ?? 'Sin texto registrado'] as const,
    ),
  ];
}

export function DeliverableCommands({
  view,
  label,
  note,
  busy,
  error,
  onCommand,
  onAdvance,
  feedback,
  feedbackBusy = false,
  onFeedback,
  enabledNote,
  renderCandidate,
}: {
  view: DeliverableStateView | undefined;
  /** Lowercase noun for copy, e.g. "logo". */
  label: string;
  /** Shown under the candidates whenever there are any (e.g. the INDECOPI note on names). */
  note?: string;
  busy: boolean;
  error: string;
  onCommand: (request: DeliverableCommandRequest) => void;
  /** UI-only navigation to the next section. Omit to hide «Avanzar». */
  onAdvance?: () => void;
  /** The owner's 👍 / 👎 by deliverable id. */
  feedback?: Readonly<Record<string, FeedbackValue>>;
  feedbackBusy?: boolean;
  /** Omit to hide the thumbs. Clicking the active thumb again sends `null` (clears the rating). */
  onFeedback?: (deliverableId: string, value: FeedbackValue | null) => void;
  /** Replaces «Ya tienes todo listo…» in the `enabled` state (e.g. a deliverable that starts from an upload). */
  enabledNote?: string;
  /** A custom preview for a candidate (D32: the nutrition label); null falls back to text / image. */
  renderCandidate?: (candidate: DeliverableStateView['candidates'][number]) => React.ReactNode | null;
}) {
  const [iterating, setIterating] = useState(false);
  const [observation, setObservation] = useState('');
  const [ownText, setOwnText] = useState<string | null>(null);

  if (!view) return null;

  const iteratingFailed = view.state === 'failed';
  const tooLong = codePoints(observation.trim()) > OBSERVATION_MAX_LENGTH;
  const submission = iterateSubmission(view, observation);
  const buttonBase =
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="mt-4 space-y-3" data-testid={`deliverable-commands-${view.agentId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATE_STYLES[view.state]}`}>
          {view.state === 'generating' && <Loader2 size={12} className="mr-1 inline animate-spin" />}
          {STATE_LABELS[view.state]}
        </span>
        {(view.activeTask ?? view.lastFailure) && (
          <span className="text-xs text-neutral-500">Iteración {(view.activeTask ?? view.lastFailure)!.iteration}</span>
        )}
        {view.stale && (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
            {STALE_LABEL}
          </span>
        )}
      </div>

      {view.inheritedFromBrand && (
        <p role="note" className="text-xs text-neutral-600">
          {inheritedFromBrandNotice(label, view.approvedDeliverableId !== null)}
        </p>
      )}
      {view.state === 'blocked' && !view.inheritedFromBrand && (
        <p className="text-xs text-neutral-500">
          {view.missingUpstream.length > 0
            ? missingUpstreamMessage(view.missingUpstream)
            : `Para habilitar tu ${label} falta: ${missingLabels(view.missingFields)}. Complétalo en el chat o en los datos de tu marca.`}
        </p>
      )}
      {view.state === 'enabled' && (
        <p className="text-xs text-neutral-500">{enabledNote ?? 'Ya tienes todo listo. Toca Generar cuando quieras.'}</p>
      )}
      {view.state === 'failed' && (
        <p role="status" className="text-xs text-red-700">
          {failedCardMessage(view, label)}
        </p>
      )}
      {view.stale && (
        <p role="status" className="text-xs text-amber-800">
          {staleNotice(view, label)}
        </p>
      )}

      {view.candidates.length > 0 && (
        <ul
          className={view.candidates.every((candidate) => textCandidate(candidate) || renderCandidate?.(candidate)) ? 'space-y-2' : 'grid grid-cols-3 gap-2'}
          aria-label="Propuestas"
        >
          {view.candidates.map((candidate, index) => {
            const isApproved = candidate.deliverableId === view.approvedDeliverableId;
            const text = textCandidate(candidate);
            const custom = candidate.approvable ? renderCandidate?.(candidate) : null;
            return (
              <li
                key={candidate.deliverableId}
                className={`flex flex-col gap-1 rounded-lg border p-1 ${isApproved ? 'border-emerald-500' : 'border-neutral-200'}`}
              >
                {!candidate.approvable ? (
                  <p role="status" className="px-1 text-xs text-amber-800">
                    {safetyReviewNotice(label)}
                  </p>
                ) : custom ? (
                  <div className="px-1">{custom}</div>
                ) : text ? (
                  <div className="px-1">
                    <p className="text-sm font-semibold text-neutral-900">{text.text}</p>
                    {text.rationale && <p className="text-xs text-neutral-600">{text.rationale}</p>}
                  </div>
                ) : candidate.contentUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={candidate.contentUrl}
                    alt={`Propuesta ${index + 1}`}
                    className="aspect-square w-full rounded object-cover"
                  />
                ) : (
                  <span className="text-xs text-neutral-500">Propuesta {index + 1}</span>
                )}
                <p className={`flex flex-wrap items-center gap-1 px-1 text-[11px] ${isApproved ? 'font-medium text-emerald-700' : 'text-neutral-600'}`}>
                  {isApproved && <CheckCircle2 size={12} />}
                  {candidateStatusLine(candidate, isApproved)}
                </p>
                {onFeedback && candidate.approvable && (
                  <div className="flex gap-1 px-1">
                    {(['up', 'down'] as const).map((value) => {
                      const pressed = feedback?.[candidate.deliverableId] === value;
                      const Icon = value === 'up' ? ThumbsUp : ThumbsDown;
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={pressed}
                          aria-label={value === 'up' ? 'Me gusta esta versión' : 'No me gusta esta versión'}
                          disabled={feedbackBusy}
                          onClick={() => onFeedback(candidate.deliverableId, pressed ? null : value)}
                          className={`rounded p-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${pressed ? 'bg-orange-100 text-orange-700' : 'text-neutral-500 hover:bg-neutral-100'}`}
                        >
                          <Icon size={14} />
                        </button>
                      );
                    })}
                  </div>
                )}
                {candidate.stale && (
                  <span className="mx-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">{STALE_LABEL}</span>
                )}
                <details className="px-1 text-[11px] text-neutral-600">
                  <summary className="cursor-pointer select-none">Detalles</summary>
                  <dl className="mt-1 space-y-0.5">
                    {provenanceRows(view.deliverableKind, candidate).map(([term, value]) => (
                      <div key={term}>
                        <dt className="inline font-medium">{term}: </dt>
                        <dd className="inline break-words">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
                {!isApproved && has(view, 'approve') && candidate.approvable && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onCommand({ kind: 'approve', deliverableId: candidate.deliverableId })}
                    className={`${buttonBase} justify-center bg-emerald-600 text-white hover:bg-emerald-500`}
                  >
                    Aprobar
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {view.candidates.length > 0 && note && (
        <p role="note" className="text-xs text-neutral-600">
          {note}
        </p>
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
        {has(view, 'use_own') && ownText === null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => (view.deliverableKind === 'logo' ? onCommand({ kind: 'use_own' }) : setOwnText(''))}
            className={`${buttonBase} border border-emerald-300 text-emerald-700 hover:bg-emerald-50`}
          >
            <UserCheck size={14} /> {USE_OWN_LABELS[view.deliverableKind] ?? 'Usar el mío'}
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

      {ownText !== null && has(view, 'use_own') && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ownText.trim()) return;
            onCommand({ kind: 'use_own', value: ownText });
            setOwnText(null);
          }}
        >
          <label className="block text-xs font-medium text-neutral-700" htmlFor={`own-${view.agentId}`}>
            Escribe tu {label}
          </label>
          <input
            id={`own-${view.agentId}`}
            value={ownText}
            maxLength={OWN_TEXT_MAX_LENGTH}
            onChange={(event) => setOwnText(event.target.value)}
            className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/50"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOwnText(null)} className={`${buttonBase} text-neutral-600 hover:bg-neutral-100`}>
              Descartar
            </button>
            <button type="submit" disabled={busy || !ownText.trim()} className={`${buttonBase} bg-emerald-600 text-white hover:bg-emerald-500`}>
              Guardar y aprobar
            </button>
          </div>
        </form>
      )}

      {iterating && has(view, 'iterate') && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!submission) return;
            onCommand(submission);
            setObservation('');
            setIterating(false);
          }}
        >
          <label className="block text-xs font-medium text-neutral-700" htmlFor={`iterate-${view.agentId}`}>
            {iteratingFailed ? '¿Qué quieres cambiar de lo que pediste?' : '¿Qué quieres cambiar de esta propuesta?'}
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
                disabled={busy || !submission}
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
