/**
 * KAN-25 conversation-list labels. Pure: derived server-side from persisted
 * state (business-name slot + last activity), no title column.
 */

/** Dates are shown in the pilot's local time so a server in UTC labels the same day the user saw. */
export const CONVERSATION_LABEL_TIME_ZONE = 'America/Lima';

export const UNNAMED_CONVERSATION_LABEL = 'Nueva conversación';
export const UNNAMED_BRAND_LABEL = 'Marca sin nombre';
export const UNNAMED_PRODUCT_LABEL = 'Producto sin nombre';

const shortDate = new Intl.DateTimeFormat('es-PE', {
  day: 'numeric',
  month: 'short',
  timeZone: CONVERSATION_LABEL_TIME_ZONE,
});

/** es-PE short day + month without the abbreviation dot: «24 oct». */
export function formatConversationDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return shortDate.format(date).replace(/\.$/, '').trim();
}

/** «Café Andino · 24 oct», or «Nueva conversación · 24 oct» before a name exists. */
export function conversationListLabel(input: {
  readonly businessName: string | null;
  readonly lastActivityAt: string;
}): string {
  const name = input.businessName?.trim() || UNNAMED_CONVERSATION_LABEL;
  const date = formatConversationDate(input.lastActivityAt);
  return date ? `${name} · ${date}` : name;
}
