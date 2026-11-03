/**
 * The brief as the panel shows it (KAN-26), built from a conversation snapshot.
 * Shared by the brief panel controller and the resume path (KAN-25), so a
 * resumed conversation renders the same fields the panel would load.
 */
import { briefFromSnapshot, type BriefFieldView } from '../core/brief';
import type { ConversationSnapshot } from '../core/contracts';

/** `FieldDelta.source` of panel edits. Audit/display only (the core never branches on it). */
export const BRIEF_PANEL_SOURCE = 'brief-panel';

/** A brief field as the panel shows it: which channel wrote the accepted value. */
export type BriefPanelField = Omit<BriefFieldView, 'source'> & { readonly source: 'chat' | 'panel' | null };

export function briefPanelFields(snapshot: ConversationSnapshot): ReadonlyArray<BriefPanelField> {
  return briefFromSnapshot(snapshot).map((field) => ({
    ...field,
    // shortcut: every non-panel source is the chat today; name new input adapters here when they exist.
    source: field.source === null ? null : field.source === BRIEF_PANEL_SOURCE ? ('panel' as const) : ('chat' as const),
  }));
}
