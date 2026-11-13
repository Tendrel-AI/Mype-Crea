import { describe, expect, it } from 'vitest';
import logoCard from '../../../../agents/logo-agent/agent-card.json';
import labelCard from '../../../../agents/label-agent/agent-card.json';
import type { AgentCard } from '../../orchestrator/agent-registry';
import { alterationKey, buildLimitCatalog, withDefaults } from '../catalog';

const cards = (...list: unknown[]) => list as AgentCard[];

describe('limit catalog derivation', () => {
  it('derives one alterations key per card, scoped by the card level, plus the fixed keys', () => {
    const catalog = buildLimitCatalog(cards(logoCard, labelCard));
    expect(catalog.map((def) => def.key).sort()).toEqual([
      'alterations.label-agent', 'alterations.logo-agent', 'brands.per_user', 'products.per_brand', 'turns.per_conversation',
    ]);
    expect(catalog.find((def) => def.key === alterationKey('logo-agent'))).toMatchObject({ scope: 'brand', default: 3, agentId: 'logo-agent' });
    expect(catalog.find((def) => def.key === alterationKey('label-agent'))?.scope).toBe('product');
  });

  it('a new agent card yields a new key with no other change', () => {
    const keys = buildLimitCatalog(cards(logoCard, { ...logoCard, name: 'social-agent' })).map((def) => def.key);
    expect(keys).toContain('alterations.social-agent');
  });

  it('withDefaults completes stored values and drops keys outside the catalog', () => {
    const catalog = buildLimitCatalog(cards(logoCard));
    expect(withDefaults(catalog, { 'turns.per_conversation': 10, 'alterations.gone-agent': 9 })).toEqual({
      'alterations.logo-agent': 3, 'turns.per_conversation': 10, 'brands.per_user': 3, 'products.per_brand': 5,
    });
  });
});
