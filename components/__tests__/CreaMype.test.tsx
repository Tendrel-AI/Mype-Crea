/**
 * KAN-25: a resumed conversation renders its persisted brief on first paint,
 * from the same snapshot projection the brief panel controller uses.
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
vi.mock('../../app/actions/deliverable-command', () => ({
  deliverableCommandAction: vi.fn(), loadDeliverableStatesAction: vi.fn(),
}));

import CreaMype from '../CreaMype';
import { briefPanelFields } from '../../src/conversations/brief-panel';
import { buildAgentRequirementState, buildSnapshot } from '../../src/core/__tests__/_fixtures';

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
