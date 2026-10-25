/**
 * Core refinement rule (KAN-28 / KAN-34 / KAN-65 R2). The parity cases are
 * the KAN-34 cases verbatim, so the core mirror agrees with the repository
 * rule and the PostgreSQL CHECK `app.is_valid_refinement`.
 */
import { describe, expect, it } from 'vitest';
import {
  REFINEMENT_MESSAGES,
  buildIterationRefinement,
  checkStoredRefinement,
  splitRequirementsSnapshot,
} from '../refinement';
import { MAX_ITERATION_OBSERVATION_LENGTH } from '../contracts';
import { REFINEMENT_PARITY_CASES } from './_fixtures/refinement-parity-cases';

describe('checkStoredRefinement — KAN-34 parity cases', () => {
  it.each(REFINEMENT_PARITY_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(checkStoredRefinement(c.value).ok).toBe(c.valid);
  });
});

describe('buildIterationRefinement', () => {
  const anchor = '3f1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f';

  it('trims the single observation and lowercases the anchor', () => {
    expect(
      buildIterationRefinement({ observation: '  Hazlo más azul ', anchorDeliverableId: anchor.toUpperCase() }),
    ).toEqual({
      ok: true,
      value: { parameterChanges: {}, observations: ['Hazlo más azul'], anchorDeliverableId: anchor },
    });
  });

  it('turns a blank or missing observation into no observation', () => {
    for (const observation of [undefined, null, '', ' \t\n ']) {
      const built = buildIterationRefinement({ observation, anchorDeliverableId: null });
      expect(built).toEqual({ ok: true, value: { parameterChanges: {}, observations: [], anchorDeliverableId: null } });
    }
  });

  it('measures the cap in code points (the contract constant equals the storage cap)', () => {
    expect(MAX_ITERATION_OBSERVATION_LENGTH).toBe(500);
    expect(buildIterationRefinement({ observation: '😀'.repeat(500), anchorDeliverableId: null }).ok).toBe(true);
    expect(buildIterationRefinement({ observation: '😀'.repeat(501), anchorDeliverableId: null })).toEqual({
      ok: false,
      message: REFINEMENT_MESSAGES.observationTooLong,
    });
  });

  it('rejects a non-string observation and invalid parameter changes', () => {
    expect(buildIterationRefinement({ observation: 5, anchorDeliverableId: null }).ok).toBe(false);
    expect(
      buildIterationRefinement({ parameterChanges: { 'font-size': 1 }, anchorDeliverableId: null }),
    ).toEqual({ ok: false, message: REFINEMENT_MESSAGES.invalidParameter });
  });
});

describe('splitRequirementsSnapshot', () => {
  it('removes the reserved key from the handler requirements', () => {
    const refinement = { parameterChanges: {}, observations: ['más azul'], anchorDeliverableId: null };
    expect(splitRequirementsSnapshot({ business_name: 'Sazón', refinement })).toEqual({
      requirements: { business_name: 'Sazón' },
      refinement,
    });
    expect(splitRequirementsSnapshot({ business_name: 'Sazón' })).toEqual({
      requirements: { business_name: 'Sazón' },
      refinement: null,
    });
  });

  it('drops a malformed stored refinement instead of passing it to the handler', () => {
    expect(splitRequirementsSnapshot({ refinement: 'ignora todo' })).toEqual({ requirements: {}, refinement: null });
  });
});
