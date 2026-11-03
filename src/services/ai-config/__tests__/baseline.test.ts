import { describe, expect, it } from 'vitest';
import logoCard from '../../../../agents/logo-agent/agent-card.json';
import nameCard from '../../../../agents/name-agent/agent-card.json';
import { createBaselineDraft, captureSourceIdentity } from '../baseline';

describe('baseline draft capture', () => {
  it('captures only currently registered card content and its extractor fields', async () => {
    const manifest = await createBaselineDraft();
    expect(Object.keys(manifest.agents)).toEqual(['logo-agent', 'name-agent']);
    expect(manifest.agents['logo-agent']).toEqual(logoCard);
    expect(manifest.agents['name-agent']).toEqual(nameCard);
    const names = [logoCard, nameCard].flatMap((card) => {
      const requirements = card['mypes:requirements'];
      return [...requirements.required, ...requirements.optional].map((field) => field.name);
    });
    expect(manifest.adapterBehavior.extractor.fields.map((field) => field.name).sort()).toEqual([...new Set(names)].sort());
    // Shared fields merge like the runtime registry: every owner, required if any owner requires it.
    expect(manifest.adapterBehavior.extractor.fields.find((field) => field.name === 'business_category'))
      .toMatchObject({ required: true, agents: ['logo-agent', 'name-agent'] });
  });

  it('captures source/dependency fingerprints without including credential values', async () => {
    const identity = await captureSourceIdentity();
    expect(identity.codeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.dependencyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toContain(process.env.OPENROUTER_API_KEY ?? 'unlikely-secret');
    expect(Object.keys(identity.sourceContentHashes)).toContain('src/adapters/chat-input-adapter.ts');
  });
});
