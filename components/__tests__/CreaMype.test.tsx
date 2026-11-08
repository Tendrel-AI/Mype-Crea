/**
 * KAN-25: a resumed conversation renders its persisted brief on first paint,
 * from the same snapshot projection the brief panel controller uses.
 * KAN-30: it also renders the messages, tasks in progress and deliverables.
 * Server render only (no DOM): effects such as the client brief reload never run here.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/actions/brief', () => ({ loadBriefAction: vi.fn(), updateBriefFieldAction: vi.fn() }));
vi.mock('../../app/actions/auth', () => ({ signOutAction: vi.fn() }));
vi.mock('../../app/actions/chat', () => ({ chatAction: vi.fn() }));
vi.mock('../../app/actions/conversations', () => ({
  createConversationAction: vi.fn(), exportConversationTraceAction: vi.fn(), listConversationsAction: vi.fn(),
}));
vi.mock('../../app/actions/brands', () => ({ archiveBrandAction: vi.fn(), createBrandAction: vi.fn() }));
vi.mock('../../app/actions/deliverable-command', () => ({
  deliverableCommandAction: vi.fn(), loadDeliverableStatesAction: vi.fn(),
}));
vi.mock('../../app/actions/deliverable-feedback', () => ({
  deliverableFeedbackAction: vi.fn(), loadDeliverableFeedbackAction: vi.fn(async () => ({ ok: true, feedback: {} })),
}));

import CreaMype from '../CreaMype';
import { briefPanelFields } from '../../src/conversations/brief-panel';
import { buildAgentRequirementState, buildSnapshot } from '../../src/core/__tests__/_fixtures';
import type { DeliverableStateView } from '../../src/core/contracts';

const CONVERSATION = '11111111-1111-4111-8111-111111111111';

describe('CreaMype resume (KAN-25)', () => {
  it('shows the persisted brief of a resumed conversation without waiting for a client reload', () => {
    const snapshot = buildSnapshot({
      agentStates: {
        'logo-agent': buildAgentRequirementState({
          requiredFields: { business_name: { status: 'filled', value: 'Café Andino', confidence: 0.95, source: 'chat-es' } },
          optionalFields: { color_palette: { status: 'filled', value: 'verde y crema', confidence: 1, source: 'brief-panel' } },
        }),
      },
    });
    const html = renderToStaticMarkup(
      <CreaMype userEmail="ana@example.invalid" userName="Ana" initialConversationId={CONVERSATION} initialBrief={briefPanelFields(snapshot)} />,
    );
    expect(html).toContain('data-testid="brief-panel"');
    expect(html).toContain('Café Andino');
    expect(html).toContain('verde y crema');
  });

  it('renders no brief panel when nothing was loaded (a new conversation)', () => {
    const html = renderToStaticMarkup(<CreaMype userEmail="ana@example.invalid" userName="Ana" initialConversationId={CONVERSATION} />);
    expect(html).not.toContain('data-testid="brief-panel"');
  });
});

describe('CreaMype progress and reload (KAN-30)', () => {
  const LOGO_URL = '/api/assets/00000000-0000-4000-8000-000000000001';
  const priorLogo = {
    deliverableId: '00000000-0000-4000-8000-000000000001',
    taskId: '10000000-0000-4000-8000-000000000001',
    contentUrl: LOGO_URL,
    contentInline: null,
    approvable: true,
    createdAt: '2026-10-25T00:00:01.000Z',
    iteration: 1,
    stale: false,
    provenance: { promptVersion: 'logo-agent.v1', agentCardVersion: '0.1.0', provider: 'fal', model: 'flux', inputs: [], upstream: [] },
  };
  const logoView = (partial: Partial<DeliverableStateView>): DeliverableStateView => ({
    agentId: 'logo-agent',
    deliverableKind: 'logo',
    state: 'in_review',
    stale: false,
    allowedCommands: [],
    missingFields: [],
    missingUpstream: [],
    activeTask: null,
    lastFailure: null,
    candidates: [priorLogo],
    approvedDeliverableId: null,
    stateToken: 'ds1-00000000',
    ...partial,
  });
  const turns = [{
    requestId: 'request-1', userMessage: 'Quiero un logo rústico', content: 'Listo, toca Generar cuando quieras.',
    stage: 'responded', failureCategory: null, notices: [],
  }];
  const render = (states: ReadonlyArray<DeliverableStateView>, deliverables = [{ kind: 'logo', contentUrl: LOGO_URL, contentInline: null }]) =>
    renderToStaticMarkup(
      <CreaMype
        userEmail="ana@example.invalid"
        userName="Ana"
        initialConversationId={CONVERSATION}
        initialTurns={turns}
        initialDeliverables={deliverables}
        initialStates={states}
      />,
    );
  const textarea = (html: string) => html.match(/<textarea[^>]*>/)?.[0] ?? '';

  it('the first paint restores messages, the task in progress and the deliverables, and the chat stays usable', () => {
    const html = render([logoView({ state: 'generating', activeTask: { taskId: 't2', status: 'in_progress', iteration: 2 } })]);
    expect(html).toContain('Quiero un logo rústico');
    expect(html).toContain('Listo, toca Generar cuando quieras.');
    expect(html).toContain('Generando');
    expect(html).toContain('Iteración 2');
    expect(html).toContain(`src="${LOGO_URL}"`);
    expect(textarea(html)).not.toBe('');
    expect(textarea(html)).not.toContain('disabled');
  });

  it('a task in progress with no logo yet shows the processing indicator on first paint', () => {
    const html = render([logoView({ state: 'generating', candidates: [], activeTask: { taskId: 't1', status: 'pending', iteration: 1 } })], []);
    expect(html).toContain('Generando logo...');
    expect(textarea(html)).not.toContain('disabled');
  });

  it('a terminal failure shows no processing indicator and keeps the prior deliverables', () => {
    const failed = logoView({
      state: 'failed',
      allowedCommands: ['retry'],
      lastFailure: { taskId: 't2', iteration: 2, errorCategory: 'transient', errorKind: 'timeout', retryable: true },
    });
    const html = render([failed]);
    expect(html).not.toContain('Generando');
    expect(html).toContain('Falló');
    expect(html).toContain('Fue un problema temporal: toca Reintentar.');
    expect(html).toContain('Iteración 1 · Lista');
    expect(html).toContain(`src="${LOGO_URL}"`);
    expect(textarea(html)).not.toContain('disabled');
  });
});
