import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TenantAnalyticsPanel from '../TenantAnalyticsPanel';
import type { BriefFieldSpec } from '../../src/core/brief';
import type { TenantAnalytics } from '../../src/repos/tenant-analytics';

const analytics: TenantAnalytics = {
  conversations: 4, turns: 20, alterations: 3, perConversation: { avgTurns: 5, avgAlterations: 0.75 },
  fields: [
    { name: 'business_category', filledConversations: 2, values: [{ value: 'ARTESANIA', count: 2 }] },
    { name: 'brand_new_field', filledConversations: 1, values: [{ value: 'AZUL', count: 1 }] },
  ],
  funnel: [{ kind: 'logo', generated: 2, altered: 1, approved: 1 }],
  users: [{ userId: 'u1', email: 'a@x.pe', conversations: 4, turns: 20, alterations: 3 }],
  dictionaryChanges: [],
};

const catalog: BriefFieldSpec[] = [
  { name: 'business_category', type: 'enum', vocabulary: 'business_category', analytics: 'category', label: 'Rubro', maxLength: 120 },
  { name: 'brand_new_field', type: 'string', analytics: 'tags', label: 'Campo nuevo', maxLength: 50 },
  { name: 'legacy_field', type: 'string', analytics: 'text', label: 'Campo viejo', maxLength: 50, deprecatedSince: '2026-10-01' },
  { name: 'hidden', type: 'string', analytics: 'none', label: 'Oculto', maxLength: 50 },
];

describe('TenantAnalyticsPanel (F23)', () => {
  const html = renderToStaticMarkup(<TenantAnalyticsPanel analytics={analytics} catalog={catalog} />);

  it('renders a section for a field added to the catalog, with its values', () => {
    expect(html).toContain('Campo nuevo');
    expect(html).toContain('AZUL');
    expect(html).toContain('Artesanía');
    expect(html).toContain('50 %');
  });

  it('shows the dictionary version, the «Retirado desde» badge, and skips analytics none', () => {
    expect(html).toContain('versión 2026-11-12');
    expect(html).toContain('Retirado desde 2026-10-01');
    expect(html).not.toContain('Oculto');
  });

  it('lists per-user counters', () => {
    expect(html).toContain('a@x.pe');
  });
});
