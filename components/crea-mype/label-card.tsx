'use client';

/**
 * D32 nutrition label card: the uploaded lab-report names, the deliverable commands and the label result
 * (`LabelResultView`, the `label` output preview). The only input is the PDFs uploaded in the chat; the
 * upload is the user's command (D30): `labelCommandAfterUpload` picks which one the client then issues.
 */

import React from 'react';
import type { DeliverableStateView } from '../../src/core/contracts';
import type { LabelResult } from '../../src/labeling/types';
import { DeliverableCommands, iterateSubmission, type DeliverableCommandRequest } from './DeliverableCommands';
import { LabelResultView } from './LabelResultView';
import { LAB_UPLOAD_LABEL, LAB_UPLOAD_OBSERVATION } from './lab-upload-copy';

const ENABLED_NOTE = `Sube el análisis de laboratorio de tu producto en PDF con el clip del chat («${LAB_UPLOAD_LABEL}»).`;

type Candidate = DeliverableStateView['candidates'][number];

/** The inline `LabelResult` of a label candidate, or null for any other deliverable. */
export function labelResultOf(candidate: Pick<Candidate, 'contentInline'>): LabelResult | null {
  const inline = candidate.contentInline as { kind?: unknown; value?: { ok?: unknown } | null } | null;
  return inline?.kind === 'label' && inline.value?.ok === true ? (inline.value as unknown as LabelResult) : null;
}

export function renderLabelCandidate(candidate: Candidate): React.ReactNode | null {
  const result = labelResultOf(candidate);
  return result ? <LabelResultView result={result} /> : null;
}

/**
 * The command a successful upload issues, from the fresh state: `generate`; else `iterate` with the upload
 * observation; else `retry`; null when none is allowed (e.g. while generating).
 */
export function labelCommandAfterUpload(
  view: Pick<DeliverableStateView, 'allowedCommands' | 'state' | 'approvedDeliverableId' | 'candidates'>,
): DeliverableCommandRequest | null {
  if (view.allowedCommands.includes('generate')) return { kind: 'generate' };
  if (view.allowedCommands.includes('iterate')) return iterateSubmission(view, LAB_UPLOAD_OBSERVATION);
  if (view.allowedCommands.includes('retry')) return { kind: 'retry' };
  return null;
}

export function LabelCard({
  view,
  reports,
  onRemove,
  uploading,
  ...commands
}: {
  view: DeliverableStateView | undefined;
  /** The product's uploaded lab reports (id and original name). */
  reports: ReadonlyArray<{ id: string; name: string }>;
  /** «Quitar»: remove one lab report. */
  onRemove: (fileId: string) => void;
  uploading: boolean;
} & Omit<React.ComponentProps<typeof DeliverableCommands>, 'view' | 'label' | 'enabledNote' | 'renderCandidate'>) {
  return (
    <section aria-label="Etiqueta nutricional">
      {reports.length > 0 ? (
        <div className="text-xs text-neutral-600" data-testid="lab-report-names">
          <p className="font-medium">Análisis de laboratorio subidos:</p>
          <ul className="list-disc pl-4">
            {reports.map(({ id, name }) => (
              <li key={id} className="break-words">
                {name}{' '}
                <button type="button" className="underline disabled:opacity-50" disabled={commands.busy} onClick={() => onRemove(id)} aria-label={`Quitar ${name}`}>Quitar</button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-neutral-500">{ENABLED_NOTE}</p>
      )}
      {uploading && <p role="status" className="mt-2 text-xs text-neutral-500">Subiendo el análisis…</p>}
      <DeliverableCommands
        {...commands}
        view={view}
        label="etiqueta"
        enabledNote={ENABLED_NOTE}
        renderCandidate={renderLabelCandidate}
      />
    </section>
  );
}
