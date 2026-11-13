'use client';

/** Advertising-photo card: the uploaded product photo names (optional input) and the deliverable commands. */

import React from 'react';
import type { DeliverableStateView } from '../../src/core/contracts';
import { DeliverableCommands } from './DeliverableCommands';

/** Local copy of the agent id: the UI never imports from `src/social`. */
export const SOCIAL_AGENT_ID = 'social-agent';

const ENABLED_NOTE = 'Si quieres, sube una foto real de tu producto con el botón de imagen del chat; si no, la creamos a partir de la descripción.';

export function SocialCard({
  view,
  photos,
  uploading,
  ...commands
}: {
  view: DeliverableStateView | undefined;
  /** The product's uploaded photos (id and original name). */
  photos: ReadonlyArray<{ id: string; name: string }>;
  uploading: boolean;
} & Omit<React.ComponentProps<typeof DeliverableCommands>, 'view' | 'label' | 'enabledNote' | 'renderCandidate'>) {
  return (
    <section aria-label="Foto publicitaria">
      {photos.length > 0 ? (
        <div className="text-xs text-neutral-600" data-testid="product-photo-names">
          <p className="font-medium">Fotos subidas:</p>
          <ul className="list-disc pl-4">
            {photos.map(({ id, name }) => <li key={id} className="break-words">{name}</li>)}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-neutral-500">{ENABLED_NOTE}</p>
      )}
      {uploading && <p role="status" className="mt-2 text-xs text-neutral-500">Subiendo la foto…</p>}
      <DeliverableCommands {...commands} view={view} label="foto publicitaria" enabledNote={ENABLED_NOTE} />
    </section>
  );
}
