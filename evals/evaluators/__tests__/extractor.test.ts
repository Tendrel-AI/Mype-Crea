/**
 * Unit tests for the Extractor scorers. Pure, no LLM: they pin the scoring
 * rules so an eval run's numbers mean what testing.md says they mean.
 */
import { describe, expect, it } from 'vitest';
import type { FieldDelta } from '../../../src/core/contracts';
import { bucketOf, flattenDeltaFields, scoreExtraction } from '../extractor';

function delta(
  fields: FieldDelta['fields'],
  intents?: FieldDelta['intents'],
): FieldDelta {
  return {
    conversationId: 'c',
    source: 'chat-es',
    timestamp: '2026-10-04T00:00:00.000Z',
    fields,
    ...(intents ? { intents } : {}),
  };
}

const score = (d: FieldDelta, e: Parameters<typeof scoreExtraction>[1]) =>
  Object.fromEntries(scoreExtraction(d, e).feedback.map((f) => [f.key, f.score]));

describe('bucketOf', () => {
  it('uses the shared CONFIDENCE_THRESHOLDS boundaries', () => {
    expect(bucketOf(0.9)).toBe('filled');
    expect(bucketOf(0.89)).toBe('pending');
    expect(bucketOf(0.6)).toBe('pending');
    expect(bucketOf(0.59)).toBe('dropped');
  });
});

describe('flattenDeltaFields', () => {
  it('folds the per-agent fan-out back to one value per field', () => {
    const d = delta({
      'tagline-agent': { business_name: { value: 'B', confidence: 1 } },
      'logo-agent': { business_name: { value: 'A', confidence: 1 } },
    });
    expect(flattenDeltaFields(d)).toEqual({ business_name: { value: 'A', confidence: 1 } });
  });
});

describe('scoreExtraction', () => {
  it('passes an exact, accent- and case-insensitive match', () => {
    const d = delta({ 'logo-agent': { business_name: { value: 'Café ANDINO', confidence: 1 } } });
    const r = scoreExtraction(d, { fields: { business_name: { contains: ['cafe andino'], bucket: 'filled' } } });
    expect(r.pass).toBe(true);
  });

  it('flags an extra field as a hallucination and lowers precision', () => {
    const d = delta({
      'logo-agent': {
        business_name: { value: 'Bodega Juana', confidence: 1 },
        color_palette: { value: 'rojo', confidence: 0.9 },
      },
    });
    const s = score(d, { fields: { business_name: { contains: ['juana'] } } });
    expect(s['extractor.no_hallucination']).toBe(0);
    expect(s['extractor.precision']).toBe(0.5);
    expect(s['extractor.recall']).toBe(1);
  });

  it('fails a value that still contains the corrected name', () => {
    const d = delta({ 'logo-agent': { business_name: { value: 'Bazar Sol', confidence: 1 } } });
    const r = scoreExtraction(d, {
      fields: { business_name: { contains: ['bazar'], notContains: ['sol'] } },
    });
    expect(r.pass).toBe(false);
  });

  it('checks the confidence bucket only when the case asks for one', () => {
    const d = delta({ 'logo-agent': { business_name: { value: 'Dulce Hogar', confidence: 0.7 } } });
    expect(score(d, { fields: { business_name: { contains: ['dulce hogar'], bucket: 'filled' } } })['extractor.confidence_bucket']).toBe(0);
    expect(score(d, { fields: { business_name: { contains: ['dulce hogar'] } } })['extractor.confidence_bucket']).toBe(1);
  });

  it('scores an empty expectation against an empty delta as a pass', () => {
    expect(scoreExtraction(delta({}), { fields: {} }).pass).toBe(true);
  });

  it('compares intents by kind and field, ignoring the agent fan-out', () => {
    const d = delta({}, [
      { kind: 'reset_field', agentId: 'logo-agent', fieldName: 'business_name' },
      { kind: 'reset_field', agentId: 'tagline-agent', fieldName: 'business_name' },
    ]);
    expect(scoreExtraction(d, { fields: {}, intents: [{ kind: 'reset_field', fieldName: 'business_name' }] }).pass).toBe(true);
    expect(scoreExtraction(d, { fields: {} }).pass).toBe(false);
  });
});
