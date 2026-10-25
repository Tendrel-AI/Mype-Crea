/**
 * Core refinement helpers (KAN-28 / KAN-34 / KAN-65 R2). The stored-shape
 * rule itself (`checkStoredRefinement`) is held to the ONE shared parity
 * fixture in src/repos/__tests__/refinement-rules.test.ts (TypeScript) and
 * approvals.integration.test.ts (PostgreSQL `app.is_valid_refinement`).
 */
import { describe, expect, it } from 'vitest';
import {
  REFINEMENT_MESSAGES,
  buildIterationRefinement,
  splitRequirementsSnapshot,
} from '../refinement';
import { MAX_ITERATION_OBSERVATION_LENGTH } from '../contracts';

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
      code: 'observation_too_long',
      message: REFINEMENT_MESSAGES.observationTooLong,
    });
  });

  it('rejects a non-string observation and invalid parameter changes', () => {
    expect(buildIterationRefinement({ observation: 5, anchorDeliverableId: null }).ok).toBe(false);
    expect(
      buildIterationRefinement({ parameterChanges: { 'font-size': 1 }, anchorDeliverableId: null }),
    ).toEqual({ ok: false, code: 'invalid_parameter_key', message: REFINEMENT_MESSAGES.invalidParameter });
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
