/**
 * deriveDeliverableState — table tests against every row of the KAN-64
 * transition table (pipeline/decisions/KAN-64-dispatch-model.md), including
 * the obsoleto overlay and the failure recovery commands (KAN-58: every
 * failure category offers at least one command).
 */
import { describe, expect, it } from 'vitest';
import { planNextDecision } from '../planner';
import { buildDefaultRegistry } from '../bootstrap-registry';
import type {
  AgentRequirementState,
  ConversationSnapshot,
  DeliverableCommandKind,
  DeliverableStateKind,
} from '../../contracts';
import type { DeliverableSpec } from '../agent-registry';
import {
  FAILURE_RECOVERY_COMMANDS,
  candidateProvenance,
  dependentKindsOf,
  deriveDeliverableStates,
  deriveStaleCandidateIds,
  deriveStaleKinds,
  requirementsFromSnapshot,
  type ApprovalFact,
  type DeliverableWorkflowFacts,
} from '../deliverable-state';
import type { WorkflowCandidate, WorkflowTask } from '../deliverable-workflow';
import { overlayRecords } from '../../brief-records';
import { inputVersion } from '../../deliverable-inputs';

const conversationId = '00000000-0000-0000-0000-000000000003';
const tenantId = '00000000-0000-0000-0000-000000000001';

const NAME_SPEC: DeliverableSpec = {
  agentId: 'name-agent',
  deliverableKind: 'business_name',
  requiredFields: ['business_profile'],
  dependsOn: [],
};
const LOGO_SPEC: DeliverableSpec = {
  agentId: 'logo-agent',
  deliverableKind: 'logo',
  requiredFields: ['business_name', 'style'],
  dependsOn: [],
};
const LABEL_SPEC: DeliverableSpec = {
  agentId: 'label-agent',
  deliverableKind: 'label',
  requiredFields: ['product'],
  dependsOn: ['logo'],
};
const SOCIAL_SPEC: DeliverableSpec = {
  agentId: 'social-agent',
  deliverableKind: 'social_pack',
  requiredFields: [],
  dependsOn: ['label'],
};

const filled = { status: 'filled', value: 'x', confidence: 1 } as const;

function agentState(fields: Record<string, boolean>): AgentRequirementState {
  return {
    requiredFields: Object.fromEntries(
      Object.entries(fields).map(([name, isFilled]) => [name, isFilled ? filled : { status: 'empty' as const }]),
    ),
    optionalFields: {},
    iterationCount: 0,
  };
}

function snapshot(agentStates: ConversationSnapshot['agentStates']): ConversationSnapshot {
  return { conversationId, tenantId, agentStates, updatedAt: '2026-10-25T00:00:00.000Z' };
}

const LOGO_READY = snapshot({ 'logo-agent': agentState({ business_name: true, style: true }) });
const LOGO_MISSING_STYLE = snapshot({ 'logo-agent': agentState({ business_name: true, style: false }) });

function task(partial: Partial<WorkflowTask> & Pick<WorkflowTask, 'id' | 'status'>): WorkflowTask {
  return {
    agentId: 'logo-agent',
    errorCategory: null,
    parentTaskId: null,
    iterationRootId: partial.id,
    iterationNumber: 1,
    iterationTrigger: null,
    createdAt: '2026-10-25T00:00:01.000Z',
    ...partial,
  };
}

function candidate(id: string, taskId: string, createdAt: string, kind = 'logo'): WorkflowCandidate {
  return {
    deliverableId: id,
    agentTaskId: taskId,
    kind,
    contentUrl: `https://cdn.test/${id}.png`,
    contentInline: null,
    createdAt,
  };
}

function facts(partial: Partial<DeliverableWorkflowFacts>): DeliverableWorkflowFacts {
  return { tasks: [], candidates: [], approvals: [], markedStaleKinds: [], ...partial };
}

function stateOf(
  snap: ConversationSnapshot,
  specs: ReadonlyArray<DeliverableSpec>,
  f: DeliverableWorkflowFacts,
  agentId = 'logo-agent',
) {
  const view = deriveDeliverableStates(snap, specs, f).find((s) => s.agentId === agentId);
  if (!view) throw new Error(`no view for ${agentId}`);
  return view;
}

const DONE = task({ id: 't1', status: 'completed' });
const C1 = candidate('d1', 't1', '2026-10-25T00:00:02.000Z');
const C2 = candidate('d2', 't2', '2026-10-25T00:00:04.000Z');
const DONE2 = task({
  id: 't2',
  status: 'completed',
  parentTaskId: 't1',
  iterationRootId: 't1',
  iterationNumber: 2,
  iterationTrigger: 'user_regenerate',
  createdAt: '2026-10-25T00:00:03.000Z',
});

interface Row {
  readonly name: string;
  readonly snap: ConversationSnapshot;
  readonly facts: DeliverableWorkflowFacts;
  readonly state: DeliverableStateKind;
  readonly stale?: boolean;
  readonly allowed: ReadonlyArray<DeliverableCommandKind>;
}

const LOGO_ROWS: ReadonlyArray<Row> = [
  {
    name: 'bloqueado: a required brief field is missing',
    snap: LOGO_MISSING_STYLE,
    facts: facts({}),
    state: 'blocked',
    allowed: [],
  },
  {
    name: 'bloqueado: the agent has no slot state yet',
    snap: snapshot({}),
    facts: facts({}),
    state: 'blocked',
    allowed: [],
  },
  {
    name: 'habilitado: preconditions met, nothing generated -> Generar',
    snap: LOGO_READY,
    facts: facts({}),
    state: 'enabled',
    allowed: ['generate'],
  },
  {
    name: 'generando (pending) -> only Cancelar',
    snap: LOGO_READY,
    facts: facts({ tasks: [task({ id: 't1', status: 'pending' })] }),
    state: 'generating',
    allowed: ['cancel'],
  },
  {
    name: 'generando (in_progress) -> no command (cancel only while pending)',
    snap: LOGO_READY,
    facts: facts({ tasks: [task({ id: 't1', status: 'in_progress' })] }),
    state: 'generating',
    allowed: [],
  },
  {
    name: 'generando wins over an existing approval (an iteration is running)',
    snap: LOGO_READY,
    facts: facts({
      tasks: [DONE, { ...DONE2, status: 'pending' }],
      candidates: [C1],
      approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }],
    }),
    state: 'generating',
    allowed: ['cancel'],
  },
  {
    name: 'en revisión: one candidate -> Iterar, Aprobar',
    snap: LOGO_READY,
    facts: facts({ tasks: [DONE], candidates: [C1] }),
    state: 'in_review',
    allowed: ['iterate', 'approve'],
  },
  {
    name: 'en revisión with a brief field reset -> Aprobar only (generative commands need preconditions)',
    snap: LOGO_MISSING_STYLE,
    facts: facts({ tasks: [DONE], candidates: [C1] }),
    state: 'in_review',
    allowed: ['approve'],
  },
  {
    name: 'aprobado, single candidate -> Iterar only',
    snap: LOGO_READY,
    facts: facts({
      tasks: [DONE],
      candidates: [C1],
      approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }],
    }),
    state: 'approved',
    allowed: ['iterate'],
  },
  {
    name: 'aprobado with another candidate -> Iterar, Aprobar (replace)',
    snap: LOGO_READY,
    facts: facts({
      tasks: [DONE, DONE2],
      candidates: [C1, C2],
      approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }],
    }),
    state: 'approved',
    allowed: ['iterate', 'approve'],
  },
  {
    name: 'fallido (transient) -> Reintentar',
    snap: LOGO_READY,
    facts: facts({ tasks: [task({ id: 't1', status: 'failed', errorCategory: 'transient' })] }),
    state: 'failed',
    allowed: ['retry'],
  },
  {
    name: 'fallido (content_policy) -> Iterar, Reintentar',
    snap: LOGO_READY,
    facts: facts({ tasks: [task({ id: 't1', status: 'failed', errorCategory: 'content_policy' })] }),
    state: 'failed',
    allowed: ['iterate', 'retry'],
  },
  {
    name: 'fallido (permanent_bug) -> Reintentar',
    snap: LOGO_READY,
    facts: facts({ tasks: [task({ id: 't1', status: 'failed', errorCategory: 'permanent_bug' })] }),
    state: 'failed',
    allowed: ['retry'],
  },
  {
    name: 'fallido (unclassified) -> Reintentar',
    snap: LOGO_READY,
    facts: facts({ tasks: [task({ id: 't1', status: 'failed', errorCategory: null })] }),
    state: 'failed',
    allowed: ['retry'],
  },
  {
    name: 'fallido (transient) but a brief field was reset -> no Reintentar',
    snap: LOGO_MISSING_STYLE,
    facts: facts({ tasks: [task({ id: 't1', status: 'failed', errorCategory: 'transient' })] }),
    state: 'failed',
    allowed: [],
  },
  {
    name: 'a failed iteration after candidates is still fallido (latest task wins)',
    snap: LOGO_READY,
    facts: facts({
      tasks: [DONE, { ...DONE2, status: 'failed', errorCategory: 'transient', iterationTrigger: 'user_regenerate' }],
      candidates: [C1],
    }),
    state: 'failed',
    allowed: ['retry'],
  },
  {
    name: 'a canceled task is ignored -> back to habilitado',
    snap: LOGO_READY,
    facts: facts({ tasks: [task({ id: 't1', status: 'canceled' })] }),
    state: 'enabled',
    allowed: ['generate'],
  },
  {
    name: 'a canceled iteration is ignored -> back to en revisión',
    snap: LOGO_READY,
    facts: facts({ tasks: [DONE, { ...DONE2, status: 'canceled' }], candidates: [C1] }),
    state: 'in_review',
    allowed: ['iterate', 'approve'],
  },
  {
    name: 'a successful retry after a failure -> en revisión',
    snap: LOGO_READY,
    facts: facts({
      tasks: [
        task({ id: 't1', status: 'failed', errorCategory: 'transient' }),
        { ...DONE2, iterationTrigger: 'failure' },
      ],
      candidates: [C2],
    }),
    state: 'in_review',
    allowed: ['iterate', 'approve'],
  },
];

describe('deriveDeliverableState — KAN-64 table (single deliverable)', () => {
  it.each(LOGO_ROWS)('$name', (row) => {
    const view = stateOf(row.snap, [LOGO_SPEC], row.facts);
    expect(view.state).toBe(row.state);
    expect(view.allowedCommands).toEqual(row.allowed);
    expect(view.stale).toBe(row.stale ?? false);
  });

  it.each(['transient', 'content_policy', 'permanent_bug', null] as const)(
    'a %s failure is never a dead end: it offers at least one recovery command',
    (errorCategory) => {
      const view = stateOf(LOGO_READY, [LOGO_SPEC], facts({ tasks: [task({ id: 't1', status: 'failed', errorCategory })] }));
      expect(view.state).toBe('failed');
      expect(view.allowedCommands).toContain('retry');
      expect([...view.allowedCommands].sort()).toEqual([...FAILURE_RECOVERY_COMMANDS[errorCategory ?? 'permanent_bug']].sort());
    },
  );

  it('offers no recovery command while the brief is incomplete, whatever the category', () => {
    for (const errorCategory of ['transient', 'content_policy', 'permanent_bug'] as const) {
      const view = stateOf(
        LOGO_MISSING_STYLE,
        [LOGO_SPEC],
        facts({ tasks: [task({ id: 't1', status: 'failed', errorCategory })] }),
      );
      expect(view.allowedCommands).toEqual([]);
    }
  });

  it('reports missing fields, the active task, the failure and the candidates', () => {
    expect(stateOf(LOGO_MISSING_STYLE, [LOGO_SPEC], facts({})).missingFields).toEqual(['style']);

    const pending = stateOf(LOGO_READY, [LOGO_SPEC], facts({ tasks: [task({ id: 't1', status: 'pending' })] }));
    expect(pending.activeTask).toEqual({ taskId: 't1', status: 'pending', iteration: 1 });

    const failed = stateOf(
      LOGO_READY,
      [LOGO_SPEC],
      facts({ tasks: [task({ id: 't1', status: 'failed', errorCategory: 'content_policy' })] }),
    );
    expect(failed.lastFailure).toEqual({ taskId: 't1', iteration: 1, errorCategory: 'content_policy', errorKind: null, retryable: false });

    const review = stateOf(LOGO_READY, [LOGO_SPEC], facts({ tasks: [DONE, DONE2], candidates: [C2, C1] }));
    expect(review.candidates.map((c) => c.deliverableId)).toEqual(['d1', 'd2']);
    expect(review.approvedDeliverableId).toBeNull();
  });

  it('ignores tasks and candidates that belong to other agents / kinds', () => {
    const view = stateOf(
      LOGO_READY,
      [LOGO_SPEC],
      facts({
        tasks: [task({ id: 'x1', status: 'pending', agentId: 'label-agent' })],
        candidates: [candidate('dx', 'x1', '2026-10-25T00:00:02.000Z', 'label')],
      }),
    );
    expect(view.state).toBe('enabled');
  });
});

describe('deriveDeliverableState — dependency map and the obsoleto overlay', () => {
  const specs = [LOGO_SPEC, LABEL_SPEC, SOCIAL_SPEC];
  const ready = snapshot({
    'logo-agent': agentState({ business_name: true, style: true }),
    'label-agent': agentState({ product: true }),
    'social-agent': agentState({}),
  });
  const labelDone = task({ id: 'l1', status: 'completed', agentId: 'label-agent' });
  const labelCandidate = candidate('dl1', 'l1', '2026-10-25T00:00:02.000Z', 'label');

  it('bloqueado: upstream kind not approved, even with every field filled', () => {
    const view = stateOf(ready, specs, facts({}), 'label-agent');
    expect(view.state).toBe('blocked');
    expect(view.allowedCommands).toEqual([]);
    expect(view.missingUpstream).toEqual(['logo']);
    expect(view.missingFields).toEqual([]);
  });

  it('habilitado once the upstream kind is approved', () => {
    const view = stateOf(
      ready,
      specs,
      facts({
        tasks: [DONE],
        candidates: [C1],
        approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }],
      }),
      'label-agent',
    );
    expect(view.state).toBe('enabled');
    expect(view.allowedCommands).toEqual(['generate']);
  });

  // The logo approval was replaced after the label was approved: the store wrote marks for every
  // transitive dependent (label, social_pack) in the replacement's transaction.
  const staleFacts = facts({
    tasks: [DONE, DONE2, labelDone],
    candidates: [C1, C2, labelCandidate],
    approvals: [
      { deliverableKind: 'logo', deliverableId: 'd2' },
      { deliverableKind: 'label', deliverableId: 'dl1' },
      { deliverableKind: 'social_pack', deliverableId: 'ds1' },
    ],
    markedStaleKinds: ['label', 'social_pack'],
  });

  it('obsoleto: an approved dependent marked stale by its upstream approval; Generar and Iterar are offered, nothing auto-regenerates', () => {
    const label = stateOf(ready, specs, staleFacts, 'label-agent');
    expect(label.state).toBe('approved');
    expect(label.stale).toBe(true);
    expect(label.allowedCommands).toEqual(['generate', 'iterate']);
    expect(label.activeTask).toBeNull();
  });

  it('obsoleto reaches the transitive dependents through their own marks', () => {
    const social = stateOf(ready, specs, staleFacts, 'social-agent');
    expect(social.stale).toBe(true);
    expect(social.state).toBe('approved');
    // KAN-35: a flagged upstream approval stays approved, so the owner can still refresh it.
    expect(social.missingUpstream).toEqual([]);
    expect(social.allowedCommands).toEqual(['generate', 'iterate']);
  });

  it('obsoleto with another candidate also offers Aprobar (replace)', () => {
    const extra = candidate('dl2', 'l2', '2026-10-25T00:00:10.000Z', 'label');
    const view = stateOf(
      ready,
      specs,
      { ...staleFacts, candidates: [...staleFacts.candidates, extra] },
      'label-agent',
    );
    expect(view.allowedCommands).toEqual(['generate', 'iterate', 'approve']);
  });

  it('re-approving the dependent clears the overlay (the store drops its mark)', () => {
    const view = stateOf(
      ready,
      specs,
      { ...staleFacts, markedStaleKinds: ['social_pack'] },
      'label-agent',
    );
    expect(view.stale).toBe(false);
    expect(view.allowedCommands).toEqual(['iterate']);
  });

  it('approval order alone never makes a kind obsoleto (no timestamp comparison)', () => {
    // Same approvals as the stale case, but no marks: e.g. two approvals that raced, or an
    // upstream approved after its dependent without a replacement. Nothing is obsoleto.
    const unmarked = { ...staleFacts, markedStaleKinds: [] };
    for (const agentId of ['logo-agent', 'label-agent', 'social-agent']) {
      expect(stateOf(ready, specs, unmarked, agentId).stale).toBe(false);
    }
    expect(stateOf(ready, specs, unmarked, 'social-agent').missingUpstream).toEqual([]);
  });

  it('a store-persisted stale mark is honored for approved kinds only', () => {
    const view = stateOf(
      ready,
      [LOGO_SPEC],
      facts({
        tasks: [DONE],
        candidates: [C1],
        approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }],
        markedStaleKinds: ['logo', 'label'],
      }),
    );
    expect(view.stale).toBe(true);
    expect(view.allowedCommands).toEqual(['generate', 'iterate']);
  });

  it('the overlay never applies to a deliverable that is not approved', () => {
    const view = stateOf(
      ready,
      specs,
      facts({
        tasks: [DONE, labelDone],
        candidates: [C1, labelCandidate],
        approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }],
        markedStaleKinds: ['label'],
      }),
      'label-agent',
    );
    expect(view.state).toBe('in_review');
    expect(view.stale).toBe(false);
  });
});

describe('KAN-35 — staleness from recorded inputs (RF-07)', () => {
  // The agreed map: verbal identity (business_name) → logo; logo → label (future edge).
  const NAME: DeliverableSpec = { agentId: 'name-agent', deliverableKind: 'business_name', requiredFields: ['business_category'], dependsOn: [] };
  const LOGO: DeliverableSpec = { agentId: 'logo-agent', deliverableKind: 'logo', requiredFields: ['business_name', 'style_keywords'], dependsOn: ['business_name'] };
  const LABEL: DeliverableSpec = { agentId: 'label-agent', deliverableKind: 'label', requiredFields: [], dependsOn: ['logo'] };
  // Unrelated deliverable with its own recorded inputs.
  const SLOGAN: DeliverableSpec = { agentId: 'tagline-agent', deliverableKind: 'tagline', requiredFields: ['business_category'], dependsOn: [] };
  const specs = [NAME, LOGO, LABEL, SLOGAN];

  const slot = (value: string) => ({ status: 'filled' as const, value, confidence: 1 });
  function brief(values: Record<string, string>, optional: Record<string, string> = {}): ConversationSnapshot {
    const state = (fields: Record<string, string>, opt: Record<string, string> = {}): AgentRequirementState => ({
      requiredFields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, slot(v)])),
      optionalFields: Object.fromEntries(Object.entries(opt).map(([k, v]) => [k, slot(v)])),
      iterationCount: 0,
    });
    return snapshot({
      'name-agent': state({ business_category: values.business_category }),
      'logo-agent': state({ business_name: values.business_name, style_keywords: values.style_keywords }, optional),
      'label-agent': state({}),
      'tagline-agent': state({ business_category: values.business_category }),
    });
  }
  const BRIEF = { business_category: 'panadería', business_name: 'Panadería Sol', style_keywords: 'rústico' };
  const used = (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, inputVersion(v)]));

  const nameTask = task({ id: 'n1', status: 'completed', agentId: 'name-agent', upstreamApprovals: {} });
  const nameA = { ...candidate('nA', 'n1', '2026-10-25T00:00:02.000Z', 'business_name'), inputVersions: used({ business_category: 'panadería' }) };
  const nameB = { ...candidate('nB', 'n1', '2026-10-25T00:00:02.500Z', 'business_name'), inputVersions: used({ business_category: 'panadería' }) };
  const logoTask = task({ id: 't1', status: 'completed', upstreamApprovals: { business_name: 'nA' }, createdAt: '2026-10-25T00:00:03.000Z' });
  const L1 = {
    ...candidate('L1', 't1', '2026-10-25T00:00:04.000Z'),
    inputVersions: used({ business_name: 'Panadería Sol', style_keywords: 'rústico' }),
  };
  const sloganTask = task({ id: 's1', status: 'completed', agentId: 'tagline-agent', upstreamApprovals: {} });
  const S1 = { ...candidate('S1', 's1', '2026-10-25T00:00:05.000Z', 'tagline'), inputVersions: used({ business_category: 'panadería' }) };

  const withNameA = facts({
    tasks: [nameTask, logoTask, sloganTask],
    candidates: [nameA, nameB, L1, S1],
    approvals: [{ deliverableKind: 'business_name', deliverableId: 'nA' }],
  });
  const withNameB: DeliverableWorkflowFacts = { ...withNameA, approvals: [{ deliverableKind: 'business_name', deliverableId: 'nB' }] };

  it('KAN-90: agents only get the principal presentation; a switched principal (record overlay) marks the logo stale', () => {
    const rec = (principal: number) => ({
      brand: {},
      product: { product_presentations: ['250 g', '500 g', '1 kg'].map((label, i) => ({ label, principal: i === principal })) },
    });
    // The stored slot is a stale cache ('250 g'); the overlay is what snapshot reads show.
    const stored = brief(BRIEF, { product_presentation: '250 g' });
    const seen = (principal: number): ConversationSnapshot =>
      ({ ...stored, agentStates: overlayRecords(stored.agentStates, rec(principal), 'brief-panel') });
    const logo = { ...L1, inputVersions: used({ business_name: BRIEF.business_name, style_keywords: BRIEF.style_keywords, product_presentation: '250 g' }) };
    const f = { ...withNameA, candidates: [nameA, nameB, logo, S1] };

    const requirements = requirementsFromSnapshot(seen(1), 'logo-agent');
    expect(requirements.product_presentation).toBe('500 g');
    expect(JSON.stringify(requirements)).not.toMatch(/250 g|1 kg|principal/);
    expect(deriveStaleCandidateIds(seen(0), specs, f).has('L1')).toBe(false);
    expect([...deriveStaleCandidateIds(seen(1), specs, f)]).toEqual(['L1']);
    expect(deriveStaleCandidateIds(stored, specs, f).has('L1')).toBe(false); // raw cache would miss it
  });

  it('the logo stays blocked until a name is approved (verbal identity → logo)', () => {
    const view = stateOf(brief(BRIEF), specs, facts({}));
    expect(view.state).toBe('blocked');
    expect(view.missingUpstream).toEqual(['business_name']);
  });

  it('a logo generated under the approved name is current', () => {
    const view = stateOf(brief(BRIEF), specs, withNameA);
    expect(view.state).toBe('in_review');
    expect(view.stale).toBe(false);
  });

  it('approving a different name marks the logo potentially outdated; nothing is generated', () => {
    const view = stateOf(brief(BRIEF), specs, withNameB);
    expect(view.state).toBe('in_review');
    expect(view.stale).toBe(true);
    expect(view.activeTask).toBeNull();
    expect(view.allowedCommands).toEqual(['generate', 'iterate', 'approve']);
  });

  it('an approved logo stays approved but flagged when the name approval is replaced', () => {
    const approvedLogo = { ...withNameB, approvals: [...withNameB.approvals, { deliverableKind: 'logo', deliverableId: 'L1' }] };
    const view = stateOf(brief(BRIEF), specs, approvedLogo);
    expect(view.state).toBe('approved');
    expect(view.approvedDeliverableId).toBe('L1');
    expect(view.stale).toBe(true);
    expect(view.allowedCommands).toEqual(['generate', 'iterate']);
  });

  it('editing a brief field the logo used marks it; editing one it did not use does not', () => {
    expect(stateOf(brief({ ...BRIEF, style_keywords: 'moderno' }), specs, withNameA).stale).toBe(true);
    expect(stateOf(brief({ ...BRIEF, business_name: 'Sol de Oro' }), specs, withNameA).stale).toBe(true);
    expect(stateOf(brief(BRIEF, { color_palette: 'rojo', product_name: 'Pan de yema' }), specs, withNameA).stale).toBe(false);
  });

  it('references are stable: switching back to the original name or value clears the flag', () => {
    const back = { ...withNameB, approvals: [{ deliverableKind: 'business_name', deliverableId: 'nA' }] };
    expect(stateOf(brief(BRIEF), specs, back).stale).toBe(false);
  });

  it('unrelated deliverables are untouched by a name or logo-input change', () => {
    const before = stateOf(brief(BRIEF), specs, withNameA, 'tagline-agent');
    for (const [snap, f] of [
      [brief(BRIEF), withNameB],
      [brief({ ...BRIEF, style_keywords: 'moderno', business_name: 'Sol de Oro' }), withNameA],
    ] as const) {
      expect(stateOf(snap, specs, f, 'tagline-agent')).toEqual(before);
      expect(stateOf(snap, specs, f, 'name-agent').stale).toBe(false);
    }
  });

  it('a new iteration under the new name is current; the old candidate stays stale in history', () => {
    const logoTask2 = task({
      id: 't2',
      status: 'completed',
      parentTaskId: 't1',
      iterationRootId: 't1',
      iterationNumber: 2,
      iterationTrigger: 'user_regenerate',
      upstreamApprovals: { business_name: 'nB' },
      createdAt: '2026-10-25T00:00:06.000Z',
    });
    const L2 = { ...candidate('L2', 't2', '2026-10-25T00:00:07.000Z'), inputVersions: L1.inputVersions };
    const f = { ...withNameB, tasks: [...withNameB.tasks, logoTask2], candidates: [...withNameB.candidates, L2] };
    expect(stateOf(brief(BRIEF), specs, f).stale).toBe(false);
    expect([...deriveStaleCandidateIds(brief(BRIEF), specs, f)]).toEqual(['L1']);
  });

  describe('KAN-29 — iteration, per-candidate staleness and provenance', () => {
    const logoTask2 = task({
      id: 't2',
      status: 'completed',
      parentTaskId: 't1',
      iterationRootId: 't1',
      iterationNumber: 2,
      iterationTrigger: 'user_regenerate',
      upstreamApprovals: { business_name: 'nB' },
      createdAt: '2026-10-25T00:00:06.000Z',
    });
    const metadata = {
      provider: 'fal',
      model: 'flux/schnell',
      prompt: 'Diseña un logo profesional…',
      promptVersion: 'logo-agent.v1',
      agentCardVersion: '0.1.0',
      inputs: { business_name: { value: 'Panadería Sol', version: inputVersion('Panadería Sol') }, style_keywords: { value: 'rústico', version: inputVersion('rústico') } },
    };
    const L2 = { ...candidate('L2', 't2', '2026-10-25T00:00:07.000Z'), inputVersions: L1.inputVersions, metadata };
    const named = (c: WorkflowCandidate, value: string) => ({ ...c, contentInline: { value, kind: 'text', metadata: {} } });
    const f: DeliverableWorkflowFacts = {
      ...withNameB,
      tasks: [...withNameB.tasks, task({ id: 'tx', status: 'canceled', createdAt: '2026-10-25T00:00:05.000Z' }), logoTask2],
      candidates: [named(nameA, 'Panadería Sol'), named(nameB, 'Sol de Oro'), L1, S1, L2],
    };

    it('numbers each candidate by its task within the type (canceled tasks skipped) and flags only the stale one', () => {
      const view = stateOf(brief(BRIEF), specs, f);
      expect(view.candidates.map((c) => [c.deliverableId, c.iteration, c.stale])).toEqual([['L1', 1, true], ['L2', 2, false]]);
    });

    it('the active or failed attempt carries the next iteration number', () => {
      const failing = { ...f, tasks: [...f.tasks, task({ id: 't3', status: 'failed', createdAt: '2026-10-25T00:00:08.000Z' })] };
      expect(stateOf(brief(BRIEF), specs, failing).lastFailure?.iteration).toBe(3);
      const running = { ...f, tasks: [...f.tasks, task({ id: 't3', status: 'in_progress', createdAt: '2026-10-25T00:00:08.000Z' })] };
      expect(stateOf(brief(BRIEF), specs, running).activeTask).toEqual({ taskId: 't3', status: 'in_progress', iteration: 3 });
    });

    it('provenance: recorded versions, model and inputs, plus the approved name the task used; never the raw prompt', () => {
      const [old, current] = stateOf(brief(BRIEF), specs, f).candidates;
      expect(current.provenance).toEqual({
        origin: 'generated',
        promptVersion: 'logo-agent.v1',
        agentCardVersion: '0.1.0',
        provider: 'fal',
        model: 'flux/schnell',
        inputs: [{ field: 'business_name', value: 'Panadería Sol' }, { field: 'style_keywords', value: 'rústico' }],
        upstream: [{ kind: 'business_name', deliverableId: 'nB', value: 'Sol de Oro' }],
      });
      expect(JSON.stringify(current.provenance)).not.toContain('Diseña');
      // A row that recorded nothing: empty, not invented.
      expect(old.provenance).toEqual({
        origin: 'generated', promptVersion: null, agentCardVersion: null, provider: null, model: null, inputs: [],
        upstream: [{ kind: 'business_name', deliverableId: 'nA', value: 'Panadería Sol' }],
      });
    });

    it('a recorded upstream reference in the inputs is listed once, as upstream', () => {
      const tagline = { ...candidate('T1', 't1', '2026-10-25T00:00:09.000Z', 'tagline'), metadata: { inputs: { business_name: { value: 'Sol de Oro', version: 'v', deliverableId: 'nB' } } } };
      expect(candidateProvenance(tagline, f).inputs).toEqual([]);
    });
  });

  it('one hop per real change: a flagged logo leaves its label alone and unblocked until the logo is replaced', () => {
    const labelTask = task({ id: 'b1', status: 'completed', agentId: 'label-agent', upstreamApprovals: { logo: 'L1' } });
    const labelCandidate = candidate('B1', 'b1', '2026-10-25T00:00:08.000Z', 'label');
    const f = {
      ...withNameB,
      tasks: [...withNameB.tasks, labelTask],
      candidates: [...withNameB.candidates, labelCandidate],
      approvals: [...withNameB.approvals, { deliverableKind: 'logo', deliverableId: 'L1' }, { deliverableKind: 'label', deliverableId: 'B1' }],
    };
    expect(stateOf(brief(BRIEF), specs, f).stale).toBe(true);
    const label = stateOf(brief(BRIEF), specs, f, 'label-agent');
    expect(label).toMatchObject({ state: 'approved', stale: false, missingUpstream: [] });
    expect(label.allowedCommands).toEqual(['iterate']);
    // Approving another logo is the real change: now the label is flagged.
    const L3 = candidate('L3', 't1', '2026-10-25T00:00:09.000Z');
    const replaced = {
      ...f,
      candidates: [...f.candidates, L3],
      approvals: f.approvals.map((a) => (a.deliverableKind === 'logo' ? { ...a, deliverableId: 'L3' } : a)),
    };
    expect(stateOf(brief(BRIEF), specs, replaced, 'label-agent').stale).toBe(true);
  });

  it('a name whose own inputs changed is flagged but still unblocks the logo', () => {
    const newRubro = brief({ ...BRIEF, business_category: 'pastelería' });
    expect(stateOf(newRubro, specs, withNameA, 'name-agent')).toMatchObject({ state: 'approved', stale: true });
    const approvedName = stateOf(newRubro, specs, withNameA, 'logo-agent');
    expect(approvedName.missingUpstream).toEqual([]);
    expect(approvedName.allowedCommands).toContain('iterate');
  });

  it('a recorded upstream reference wins over a legacy stale mark', () => {
    const back = { ...withNameA, approvals: [...withNameA.approvals, { deliverableKind: 'logo', deliverableId: 'L1' }], markedStaleKinds: ['logo'] };
    expect(stateOf(brief(BRIEF), specs, back).stale).toBe(false);
  });
});

describe('KAN-33 — a candidate that did not pass the safety check', () => {
  const REJECTED = { ...C2, approvable: false };

  it.each([
    ['only candidate rejected', [{ ...C1, approvable: false }], ['generate', 'iterate']],
    ['newest rejected, older passed', [C1, REJECTED], ['generate', 'iterate', 'approve']],
    ['newest passed, older rejected', [{ ...C1, approvable: false }, C2], ['iterate', 'approve']],
  ] as const)('%s: no URL, never approvable, Generar is its review path', (_name, candidates, allowed) => {
    const view = stateOf(LOGO_READY, [LOGO_SPEC], facts({ tasks: [DONE, DONE2], candidates: [...candidates] }));
    expect(view.state).toBe('in_review');
    expect(view.allowedCommands).toEqual(allowed);
    for (const c of view.candidates) {
      expect(c.contentUrl === null).toBe(!c.approvable);
    }
  });

  it('an approved logo with only a rejected alternative offers no Aprobar (replace) for it', () => {
    const view = stateOf(LOGO_READY, [LOGO_SPEC], facts({
      tasks: [DONE, DONE2],
      candidates: [C1, REJECTED],
      approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }],
    }));
    expect(view.state).toBe('approved');
    expect(view.allowedCommands).toEqual(['iterate']);
  });

  it('candidates without a recorded verdict stay approvable (text deliverables, pre-KAN-33 images)', () => {
    const view = stateOf(LOGO_READY, [LOGO_SPEC], facts({ tasks: [DONE], candidates: [C1] }));
    expect(view.candidates[0]).toMatchObject({ approvable: true, contentUrl: 'https://cdn.test/d1.png' });
  });
});

describe('deriveStaleKinds / dependentKindsOf', () => {
  const specs = [NAME_SPEC, LOGO_SPEC, LABEL_SPEC, SOCIAL_SPEC];
  const approvals: ApprovalFact[] = [
    { deliverableKind: 'logo', deliverableId: 'a' },
    { deliverableKind: 'label', deliverableId: 'b' },
    { deliverableKind: 'social_pack', deliverableId: 'c' },
  ];

  it('is exactly the explicitly marked kinds that are approved', () => {
    expect([...deriveStaleKinds(approvals, [])]).toEqual([]);
    expect([...deriveStaleKinds(approvals, ['label'])].sort()).toEqual(['label']);
    expect([...deriveStaleKinds(approvals, ['label', 'social_pack', 'tagline'])].sort()).toEqual(['label', 'social_pack']);
    expect([...deriveStaleKinds([], ['label'])]).toEqual([]);
  });

  it('lists transitive dependents, sorted, excluding the kind itself', () => {
    expect(dependentKindsOf('logo', specs)).toEqual(['label', 'social_pack']);
    expect(dependentKindsOf('label', specs)).toEqual(['social_pack']);
    expect(dependentKindsOf('business_name', specs)).toEqual([]);
  });
});

describe('determinism and the state token', () => {
  const base = facts({ tasks: [DONE], candidates: [C1] });

  it('same inputs produce identical views', () => {
    expect(deriveDeliverableStates(LOGO_READY, [LOGO_SPEC], base)).toEqual(
      deriveDeliverableStates(LOGO_READY, [LOGO_SPEC], base),
    );
  });

  it('views are sorted by agent id', () => {
    const ids = deriveDeliverableStates(LOGO_READY, [SOCIAL_SPEC, LOGO_SPEC, LABEL_SPEC]).map((v) => v.agentId);
    expect(ids).toEqual(['label-agent', 'logo-agent', 'social-agent']);
  });

  it('the token changes when any decision-relevant fact changes', () => {
    const token = stateOf(LOGO_READY, [LOGO_SPEC], base).stateToken;
    expect(stateOf(LOGO_READY, [LOGO_SPEC], facts({ tasks: [DONE, DONE2], candidates: [C1, C2] })).stateToken).not.toBe(token);
    expect(stateOf(LOGO_MISSING_STYLE, [LOGO_SPEC], base).stateToken).not.toBe(token);
    expect(
      stateOf(
        LOGO_READY,
        [LOGO_SPEC],
        { ...base, approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }] },
      ).stateToken,
    ).not.toBe(token);
  });

  it('the token changes when an explicit stale mark appears or clears on the approved kind', () => {
    const approved = { ...base, approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }] };
    const fresh = stateOf(LOGO_READY, [LOGO_SPEC], approved).stateToken;
    const stale = stateOf(LOGO_READY, [LOGO_SPEC], { ...approved, markedStaleKinds: ['logo'] }).stateToken;
    expect(stale).not.toBe(fresh);
    // A mark on another kind is irrelevant to this view.
    expect(stateOf(LOGO_READY, [LOGO_SPEC], { ...approved, markedStaleKinds: ['label'] }).stateToken).toBe(fresh);
  });

  it('the token ignores irrelevant facts (snapshot timestamp)', () => {
    const token = stateOf(LOGO_READY, [LOGO_SPEC], base).stateToken;
    expect(stateOf({ ...LOGO_READY, updatedAt: '2030-01-01T00:00:00.000Z' }, [LOGO_SPEC], base).stateToken).toBe(token);
  });
});

describe('KAN-89 — brand-level kinds and «Usar mi …»', () => {
  const NAME_OWN: DeliverableSpec = { ...NAME_SPEC, requiredFields: [], level: 'brand', ownSource: 'text' };
  const none = { tasks: [], candidates: [], approvals: [], markedStaleKinds: [] } as DeliverableWorkflowFacts;
  const snap = (hasProduct: boolean): ConversationSnapshot => ({
    ...snapshot({ 'name-agent': agentState({}) }),
    links: { hasBrand: true, hasProduct } as never,
  });

  it('offers use_own next to generate in the brand chat', () => {
    const view = stateOf(snap(false), [NAME_OWN], none, 'name-agent');
    expect(view).toMatchObject({ state: 'enabled', level: 'brand', inheritedFromBrand: false });
    expect(view.allowedCommands).toEqual(['generate', 'use_own']);
  });

  it('a product chat never generates a brand-level kind: blocked, no commands, until the brand approves it', () => {
    const view = stateOf(snap(true), [NAME_OWN], none, 'name-agent');
    expect(view).toMatchObject({ state: 'blocked', inheritedFromBrand: true, allowedCommands: [] });
  });

  it('D35: once the own name is adopted (approved) neither the state nor the planner offers «Generar»; pending keeps the offer', () => {
    const adopted = { ...none, candidates: [candidate('d1', 't1', '2026-10-25T00:00:02.000Z', 'business_name')], approvals: [{ deliverableKind: 'business_name', deliverableId: 'd1' }] } as DeliverableWorkflowFacts;
    const registry = buildDefaultRegistry();
    const plan = (facts: DeliverableWorkflowFacts) =>
      planNextDecision(snap(false), registry, { deliverableStates: deriveDeliverableStates(snap(false), [NAME_OWN], facts) });
    const view = stateOf(snap(false), [NAME_OWN], adopted, 'name-agent');
    expect(view.state).toBe('approved');
    expect(view.allowedCommands).not.toContain('generate');
    expect(plan(adopted).map((d) => d.kind)).not.toContain('offer_generation');
    expect(stateOf(snap(false), [NAME_OWN], none, 'name-agent').allowedCommands).toContain('generate');
  });

  it('a kind without ownSource never offers use_own', () => {
    expect(stateOf(snap(false), [{ ...NAME_OWN, ownSource: undefined }], none, 'name-agent').allowedCommands).toEqual(['generate']);
  });
});

describe('D32 user-facing failure message', () => {
  const failed = (errorKind: string) =>
    task({ id: 't1', status: 'failed', errorCategory: 'permanent_bug', errorKind, errorMessage: 'Mensaje para el usuario' });

  it('exposes the message only for user-facing kinds', () => {
    const run = (kind: string) => stateOf(LOGO_READY, [LOGO_SPEC], facts({ tasks: [failed(kind)] })).lastFailure;
    expect(run('lab_report_unusable')).toMatchObject({ errorMessage: 'Mensaje para el usuario' });
    expect(run('handler_threw')).not.toHaveProperty('errorMessage');
  });
});
