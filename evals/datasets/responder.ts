/**
 * Responder dataset v1: synthetic planner plans covering every
 * PlannerDecision kind the Responder can receive, plus the bundles the
 * orchestrator produces (dispatch + next request). Synthetic only.
 *
 * `mustNotMention` encodes the guardrail "never mention user values unless
 * the current decision carries them": values that appear in
 * `recentMessages` but not in the decisions must not leak into the reply.
 */
import type { MessageRow } from '../../src/repos/models';
import type { AgentRequirementState, PlannerDecision } from '../../src/core/contracts';
import type { ResponderExpectation } from '../evaluators/responder';

export const RESPONDER_DATASET_VERSION = 'responder-cases.v1';

type Recent = ReadonlyArray<Pick<MessageRow, 'role' | 'content'>>;

export interface ResponderCase {
  readonly id: string;
  readonly tags: ReadonlyArray<string>;
  readonly inputs: {
    readonly decisions: ReadonlyArray<PlannerDecision>;
    readonly recentMessages: Recent;
    readonly logoState: AgentRequirementState;
  };
  readonly expected: ResponderExpectation;
}

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const DELIVERABLE_ID = '22222222-2222-4222-8222-222222222222';

const NAME_HINT = '¿Qué nombre debe llevar el logo?';
const STYLE_HINT = 'Describe el estilo del logo (por ejemplo: minimalista, colorido, tradicional).';
const COLOR_HINT = '¿Tienes colores preferidos para tu marca?';

const empty: AgentRequirementState = {
  requiredFields: { business_name: { status: 'empty' }, style_keywords: { status: 'empty' } },
  optionalFields: { color_palette: { status: 'empty' } },
  iterationCount: 0,
};

const nameFilled: AgentRequirementState = {
  ...empty,
  requiredFields: {
    business_name: { status: 'filled', value: 'Café Andino', confidence: 1 },
    style_keywords: { status: 'empty' },
  },
};

const allFilled: AgentRequirementState = {
  requiredFields: {
    business_name: { status: 'filled', value: 'Café Andino', confidence: 1 },
    style_keywords: { status: 'filled', value: 'rústico', confidence: 0.9 },
  },
  optionalFields: { color_palette: { status: 'filled', value: 'verde y marrón', confidence: 0.9 } },
  lastDispatchedTaskId: TASK_ID,
  iterationCount: 1,
};

const nameTurn: Recent = [
  { role: 'assistant', content: '¿Qué nombre debe llevar tu logo?' },
  { role: 'user', content: 'Se llama Café Andino' },
];

export const responderCases: ReadonlyArray<ResponderCase> = [
  {
    id: 'request-two-fields-first-turn',
    tags: ['request_fields'],
    inputs: {
      decisions: [
        {
          kind: 'request_fields',
          agentId: 'logo-agent',
          fields: [
            { fieldName: 'business_name', promptHint: NAME_HINT },
            { fieldName: 'style_keywords', promptHint: STYLE_HINT },
          ],
        },
      ],
      recentMessages: [{ role: 'user', content: 'Hola, quiero crear mi marca' }],
      logoState: empty,
    },
    expected: {},
  },
  {
    id: 'request-one-field-no-leak',
    tags: ['request_fields', 'leak'],
    inputs: {
      decisions: [
        { kind: 'request_fields', agentId: 'logo-agent', fields: [{ fieldName: 'style_keywords', promptHint: STYLE_HINT }] },
      ],
      recentMessages: nameTurn,
      logoState: nameFilled,
    },
    expected: { mustNotMention: ['Café Andino'] },
  },
  {
    id: 'request-after-reset',
    tags: ['request_fields'],
    inputs: {
      decisions: [
        {
          kind: 'request_fields',
          agentId: 'logo-agent',
          fields: [{ fieldName: 'business_name', promptHint: NAME_HINT, previousValue: 'Dulce Hogar' }],
        },
      ],
      recentMessages: [
        { role: 'assistant', content: 'Entiendo que tu negocio se llama Dulce Hogar, ¿es correcto?' },
        { role: 'user', content: 'No' },
      ],
      logoState: empty,
    },
    expected: {},
  },
  {
    id: 'request-optional-colors',
    tags: ['request_fields'],
    inputs: {
      decisions: [
        { kind: 'request_fields', agentId: 'logo-agent', fields: [{ fieldName: 'color_palette', promptHint: COLOR_HINT }] },
      ],
      recentMessages: nameTurn,
      logoState: nameFilled,
    },
    expected: { mustNotMention: ['Café Andino'] },
  },
  {
    id: 'request-user-greets-again',
    tags: ['request_fields', 'greeting-bait'],
    inputs: {
      decisions: [
        { kind: 'request_fields', agentId: 'logo-agent', fields: [{ fieldName: 'business_name', promptHint: NAME_HINT }] },
      ],
      recentMessages: [{ role: 'user', content: '¡¡Hola!! Buenas tardes 😊' }],
      logoState: empty,
    },
    expected: {},
  },
  {
    id: 'request-user-writes-voseo',
    tags: ['request_fields', 'voseo-bait'],
    inputs: {
      decisions: [
        { kind: 'request_fields', agentId: 'logo-agent', fields: [{ fieldName: 'style_keywords', promptHint: STYLE_HINT }] },
      ],
      recentMessages: [
        { role: 'user', content: 'Che, vos decime qué necesitás y yo te cuento' },
      ],
      logoState: nameFilled,
    },
    expected: {},
  },
  {
    id: 'confirm-name',
    tags: ['confirm_field'],
    inputs: {
      decisions: [
        { kind: 'confirm_field', agentId: 'logo-agent', fieldName: 'business_name', pendingValue: 'Dulce Hogar', reason: 'low_confidence' },
      ],
      recentMessages: [{ role: 'user', content: 'Creo que lo voy a llamar algo como Dulce Hogar' }],
      logoState: {
        ...empty,
        requiredFields: {
          business_name: { status: 'pending_confirmation', value: 'Dulce Hogar', confidence: 0.7 },
          style_keywords: { status: 'empty' },
        },
      },
    },
    expected: { mustMention: ['Dulce Hogar'] },
  },
  {
    id: 'confirm-style',
    tags: ['confirm_field'],
    inputs: {
      decisions: [
        { kind: 'confirm_field', agentId: 'logo-agent', fieldName: 'style_keywords', pendingValue: 'elegante', reason: 'low_confidence' },
      ],
      recentMessages: [{ role: 'user', content: 'Tal vez algo elegante, no sé' }],
      logoState: nameFilled,
    },
    expected: { mustMention: ['elegante'] },
  },
  {
    id: 'dispatch-alone',
    tags: ['announce_dispatch'],
    inputs: {
      decisions: [{ kind: 'announce_dispatch', agentId: 'logo-agent', taskId: TASK_ID }],
      recentMessages: [{ role: 'user', content: 'Rústico, en verde y marrón' }],
      logoState: allFilled,
    },
    expected: { mustNotMention: ['Café Andino'] },
  },
  {
    id: 'dispatch-then-request',
    tags: ['announce_dispatch', 'request_fields', 'bundle'],
    inputs: {
      decisions: [
        { kind: 'announce_dispatch', agentId: 'logo-agent', taskId: TASK_ID },
        {
          kind: 'request_fields',
          agentId: 'tagline-agent',
          fields: [{ fieldName: 'business_profile', promptHint: 'Recuérdame el valor principal o promesa del negocio.' }],
        },
      ],
      recentMessages: [{ role: 'user', content: 'Rústico, en verde y marrón' }],
      logoState: allFilled,
    },
    expected: {},
  },
  {
    id: 'completion-image',
    tags: ['announce_completion'],
    inputs: {
      decisions: [
        {
          kind: 'announce_completion',
          agentId: 'logo-agent',
          taskId: TASK_ID,
          deliverableIds: [DELIVERABLE_ID],
          artifacts: [{ kind: 'image', url: 'https://example.invalid/logo.png', metadata: { purpose: 'logo' } }],
        },
      ],
      recentMessages: [{ role: 'user', content: '¿Ya está mi logo?' }],
      logoState: allFilled,
    },
    expected: { mustNotMention: ['example.invalid'] },
  },
  {
    id: 'completion-text-options',
    tags: ['announce_completion'],
    inputs: {
      decisions: [
        {
          kind: 'announce_completion',
          agentId: 'tagline-agent',
          taskId: TASK_ID,
          deliverableIds: [DELIVERABLE_ID],
          artifacts: [
            { kind: 'text', inline: 'Del campo a tu taza' },
            { kind: 'text', inline: 'Sabor que nace en los Andes' },
          ],
        },
      ],
      recentMessages: [{ role: 'user', content: 'Cercano y cálido' }],
      logoState: allFilled,
    },
    // Listing two numbered options plus the ask needs more than two sentences.
    expected: { mustMention: ['Del campo a tu taza', 'Sabor que nace en los Andes'], maxSentences: 4 },
  },
  {
    id: 'all-complete',
    tags: ['announce_all_complete'],
    inputs: {
      decisions: [{ kind: 'announce_all_complete' }],
      recentMessages: [{ role: 'user', content: 'Me encanta el logo' }],
      logoState: allFilled,
    },
    expected: { mustNotMention: ['Café Andino', 'rústico'] },
  },
  {
    id: 'selection',
    tags: ['request_selection'],
    inputs: {
      decisions: [{ kind: 'request_selection', agentId: 'logo-agent', candidateDeliverableIds: [DELIVERABLE_ID, TASK_ID] }],
      recentMessages: [{ role: 'user', content: 'Muéstrame opciones' }],
      logoState: allFilled,
    },
    expected: { mustNotMention: [DELIVERABLE_ID, TASK_ID] },
  },
  {
    id: 'empty-plan',
    tags: ['degenerate'],
    inputs: { decisions: [], recentMessages: [], logoState: empty },
    expected: {},
  },
];
