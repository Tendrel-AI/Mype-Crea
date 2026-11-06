import { describe, expect, it } from 'vitest';
import { canonicalizeManifestJson, diffManifests, exportManifest, freezeManifest, importManifest, validateManifest } from '../manifest';
import { createCurrentAdapterBehaviorSnapshot } from '../adapter-behavior';

function manifest() {
  return {
    manifestVersion: 1,
    adapterBehavior: createCurrentAdapterBehaviorSnapshot(),
    agents: { 'logo-agent': { name: 'logo-agent', description: 'Full card', version: '0.1.0', skills: [], promptHint: 'Use neutral Spanish' } },
    models: [
      { id: 'extractor-primary', purpose: 'extractor', provider: 'openrouter', model: 'openai/gpt-4o-mini', modelRevision: null, credentialRef: 'vault:openrouter-prod', capabilities: ['forced-tool-call', 'json-schema'], settings: { temperature: 0, maxTokens: 1200 } },
      { id: 'extractor-fallback', purpose: 'extractor', provider: 'anthropic', model: 'claude-sonnet-4-5', modelRevision: '20250929', credentialRef: 'vault:anthropic-prod', capabilities: ['forced-tool-call', 'json-schema'], settings: { temperature: 0, maxTokens: 1200 } },
      { id: 'responder-primary', purpose: 'responder', provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5', modelRevision: null, credentialRef: 'vault:openrouter-prod', capabilities: [], settings: { temperature: 0.7, maxTokens: 1800 } },
    ],
    fallback: {
      extractor: { primaryProfileId: 'extractor-primary', fallbackProfileIds: ['extractor-fallback'], maxAttempts: 2 },
      responder: { primaryProfileId: 'responder-primary', fallbackProfileIds: [], maxAttempts: 1 },
    },
    planner: { version: 'planner.v1', thresholds: { confidence: { required: 0.8, optional: 0.7 } } },
    merge: { version: 'merge.v1' }, runtimeCompatibility: { min: '1.0.0', max: '2.0.0' },
    snapshot: { code: 'sha256:code-snapshot-a', dependencies: 'sha256:deps-snapshot-a', sourceContentHashes: { 'agents/logo-agent/agent-card.json': 'a'.repeat(64) } },
    externalRefs: { git: { repository: 'https://github.com/Tendrel-AI/Mype-Crea', commit: '0123456789abcdef0123456789abcdef01234567' }, langsmith: { prompt: 'mypes-extractor', commit: 'abcdef0123456789' } },
  };
}

describe('AI configuration manifest', () => {
  it('validates, deeply freezes, imports and exports inert content', () => {
    const source = manifest();
    const result = freezeManifest(source);
    expect(Object.isFrozen(result.content)).toBe(true);
    expect(Object.isFrozen(result.content.models[0])).toBe(true);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(importManifest(exportManifest(source))).toEqual(result);
    expect(Object.isFrozen(validateManifest(source).adapterBehavior.extractor)).toBe(true);
  });

  it('hashes sorted object keys while preserving array order', () => {
    const original = manifest();
    const reordered = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    reordered.adapterBehavior = { responder: (original.adapterBehavior as any).responder, schemaVersion: 'adapter-behavior.v1', extractor: (original.adapterBehavior as any).extractor };
    reordered.snapshot = { sourceContentHashes: { 'agents/logo-agent/agent-card.json': 'a'.repeat(64) }, dependencies: 'sha256:deps-snapshot-a', code: 'sha256:code-snapshot-a' };
    expect(freezeManifest(reordered).contentHash).toBe(freezeManifest(original).contentHash);
    const reorderedModels = JSON.parse(JSON.stringify(original)) as any;
    reorderedModels.models.reverse();
    expect(freezeManifest(reorderedModels).contentHash).not.toBe(freezeManifest(original).contentHash);
  });

  it('matches PostgreSQL jsonb canonical scalar and C-collation key ordering', () => {
    expect(canonicalizeManifestJson({ z: 1e21, '😀': 2, '\uE000': 3 } as any))
      .toBe('{"z":1000000000000000000000,"":3,"😀":2}');
    expect(canonicalizeManifestJson({ decimal: 1.2, exponent: 1e-7 } as any))
      .toBe('{"decimal":1.2,"exponent":0.0000001}');
  });

  it('changes identity when prompt, model, Agent Card or settings change and reports diffs', () => {
    const original = manifest();
    const base = freezeManifest(original).contentHash;
    const changes = [
      (m: any) => { m.adapterBehavior.extractor.promptTemplate += ' revised'; },
      (m: any) => { m.models[0].model = 'openai/gpt-4.1-mini'; },
      (m: any) => { m.agents['logo-agent'].description = 'Revised card'; },
      (m: any) => { m.models[0].settings.temperature = 0.2; },
    ];
    for (const change of changes) { const candidate = structuredClone(original); change(candidate); expect(freezeManifest(candidate).contentHash).not.toBe(base); }
    const changed = structuredClone(original); (changed.adapterBehavior.extractor as any).promptTemplate += ' revised';
    expect(diffManifests(original, changed).map(({ path }) => path)).toContain('/adapterBehavior/extractor/promptTemplate');
  });

  it('rejects unsupported versions, unknown fields, malformed models, and missing frozen content', () => {
    const wrongVersion = manifest(); (wrongVersion as any).manifestVersion = 2;
    expect(() => validateManifest(wrongVersion)).toThrow(/unsupported manifest version/);
    const unknown = manifest(); (unknown as any).unexpected = true;
    expect(() => validateManifest(unknown)).toThrow(/unknown field/);
    const invalidModel = manifest(); (invalidModel as any).models[0].model = 'claude-sonnet-4-5';
    expect(() => validateManifest(invalidModel)).toThrow(/malformed openrouter model ID/);
    const missingTemplate = manifest(); (missingTemplate as any).adapterBehavior.responder.promptTemplate = '';
    expect(() => validateManifest(missingTemplate)).toThrow(/promptTemplate/);
  });

  it('rejects secret-bearing fields and never includes them in exports', () => {
    const leaked = manifest() as any; leaked.agents['logo-agent'].apiKey = 'should-not-export';
    expect(() => exportManifest(leaked)).toThrow(/secret-bearing field names/);
    expect(exportManifest(manifest())).not.toMatch(/apiKey|should-not-export/);
    const promptSecret: any = manifest();
    promptSecret.adapterBehavior.extractor.promptTemplate += ' sk-ant-testsecretvalue123456789';
    expect(() => validateManifest(promptSecret)).toThrow(/recognizable credential material/);
  });

  it('rejects cycles, duplicate fallback links, insufficient capabilities and unbounded policy', () => {
    const cyclic: any = manifest(); cyclic.agents['logo-agent'].loop = cyclic;
    expect(() => validateManifest(cyclic)).toThrow(/cyclic content/);
    const duplicate: any = manifest(); duplicate.fallback.extractor.fallbackProfileIds = ['extractor-primary'];
    expect(() => validateManifest(duplicate)).toThrow(/cycle or duplicate/);
    const incapable: any = manifest(); incapable.models[1].capabilities = [];
    expect(() => validateManifest(incapable)).toThrow(/missing required extractor capability/);
    const unbounded: any = manifest(); unbounded.fallback.extractor.maxAttempts = 0;
    expect(() => validateManifest(unbounded)).toThrow(/one or two/);
    const overPolicy: any = manifest(); overPolicy.fallback.extractor.maxAttempts = 3;
    expect(() => validateManifest(overPolicy)).toThrow(/one or two/);
    const actualSecret: any = manifest(); actualSecret.models[0].credentialRef = 'sk-or-privatevalue';
    expect(() => validateManifest(actualSecret)).toThrow(/recognizable credential material/);
  });

  it('rejects non-JSON objects, non-finite values, sparse arrays and empty source identity', () => {
    const nonFinite: any = manifest(); nonFinite.models[0].settings.temperature = Number.NaN;
    expect(() => validateManifest(nonFinite)).toThrow(/non-finite/);
    const date: any = manifest(); date.agents['logo-agent'].createdAt = new Date();
    expect(() => validateManifest(date)).toThrow(/plain JSON object/);
    const sparse: any = manifest(); sparse.agents['logo-agent'].extra = new Array(2);
    expect(() => validateManifest(sparse)).toThrow(/sparse arrays/);
    const missingHash: any = manifest(); missingHash.snapshot.sourceContentHashes = {};
    expect(() => validateManifest(missingHash)).toThrow(/at least one supplied source content hash/);
  });
});
