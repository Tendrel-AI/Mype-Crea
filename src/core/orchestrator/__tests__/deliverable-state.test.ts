/**
 * deriveDeliverableState — table tests against every row of the KAN-64
 * transition table (pipeline/decisions/KAN-64-dispatch-model.md), including
 * the obsoleto overlay and the failure recovery commands (KAN-58: every
 * failure category offers at least one command).
 */
import { describe, expect, it } from 'vitest';
import type {
  AgentRequirementState,
  ConversationSnapshot,
  DeliverableCommandKind,
  DeliverableStateKind,
} from '../../contracts';
import type { DeliverableSpec } from '../agent-registry';
import {
  FAILURE_RECOVERY_COMMANDS,
  dependentKindsOf,
  deriveDeliverableStates,
  deriveStaleKinds,
  type ApprovalFact,
  type DeliverableWorkflowFacts,
} from '../deliverable-state';
import type { WorkflowCandidate, WorkflowTask } from '../deliverable-workflow';

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
    expect(pending.activeTask).toEqual({ taskId: 't1', status: 'pending' });

    const failed = stateOf(
      LOGO_READY,
      [LOGO_SPEC],
      facts({ tasks: [task({ id: 't1', status: 'failed', errorCategory: 'content_policy' })] }),
    );
    expect(failed.lastFailure).toEqual({ taskId: 't1', errorCategory: 'content_policy', retryable: false });

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
    // Its upstream (label) is stale, so generative commands are gated.
    expect(social.missingUpstream).toEqual(['label']);
    expect(social.allowedCommands).toEqual([]);
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
