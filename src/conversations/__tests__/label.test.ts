import { describe, expect, it } from 'vitest';
import { conversationListLabel, formatConversationDate, UNNAMED_CONVERSATION_LABEL } from '../label';

describe('conversation list labels (KAN-25)', () => {
  it('formats the date as es-PE short day + month without the abbreviation dot', () => {
    expect(formatConversationDate('2026-10-24T15:00:00.000Z')).toBe('24 oct');
    expect(formatConversationDate('2026-01-05T15:00:00.000Z')).toBe('5 ene');
  });

  it('uses Lima time, not the server time zone', () => {
    // 02:00 UTC on Oct 25 is still Oct 24 in Lima (UTC-5).
    expect(formatConversationDate('2026-10-25T02:00:00.000Z')).toBe('24 oct');
  });

  it('labels with the business name and the date', () => {
    expect(conversationListLabel({ businessName: 'Café Andino', lastActivityAt: '2026-10-24T15:00:00.000Z' }))
      .toBe('Café Andino · 24 oct');
  });

  it('falls back to «Nueva conversación» before a name exists', () => {
    expect(UNNAMED_CONVERSATION_LABEL).toBe('Nueva conversación');
    expect(conversationListLabel({ businessName: null, lastActivityAt: '2026-10-24T15:00:00.000Z' }))
      .toBe('Nueva conversación · 24 oct');
    expect(conversationListLabel({ businessName: '   ', lastActivityAt: '2026-10-24T15:00:00.000Z' }))
      .toBe('Nueva conversación · 24 oct');
  });

  it('omits an unparsable date instead of printing «Invalid Date»', () => {
    expect(conversationListLabel({ businessName: 'Café Andino', lastActivityAt: 'not-a-date' })).toBe('Café Andino');
  });
});
