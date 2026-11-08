/**
 * The brief as the panel shows it (KAN-26), built from a conversation snapshot.
 * Shared by the brief panel controller and the resume path (KAN-25), so a
 * resumed conversation renders the same fields the panel would load.
 */
import { briefFromSnapshot, type BriefFieldView } from '../core/brief';
import { briefOrigin, type BriefOrigin, type ConversationLinks } from '../core/brief-records';
import type { ConversationSnapshot } from '../core/contracts';

/** `FieldDelta.source` of panel edits. Audit/display only (the core never branches on it). */
export const BRIEF_PANEL_SOURCE = 'brief-panel';

/** A brief field as the panel shows it: which channel wrote the accepted value. */
export type BriefPanelField = Omit<BriefFieldView, 'source'> & {
  readonly source: 'chat' | 'panel' | null;
  /** KAN-88: where the value is stored: the brand, the product, or only this conversation. */
  readonly origin: BriefOrigin;
};

/** `links`: whether the conversation belongs to a brand / product; absent (legacy) means every field is local. */
export function briefPanelFields(
  snapshot: ConversationSnapshot,
  links: ConversationLinks = { hasBrand: false, hasProduct: false },
): ReadonlyArray<BriefPanelField> {
  return briefFromSnapshot(snapshot).map((field) => ({
    ...field,
    origin: briefOrigin(field.name, links),
    // shortcut: every non-panel source is the chat today; name new input adapters here when they exist.
    source: field.source === null ? null : field.source === BRIEF_PANEL_SOURCE ? ('panel' as const) : ('chat' as const),
  }));
}
