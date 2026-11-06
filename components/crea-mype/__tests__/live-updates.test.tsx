/**
 * KAN-30: SSE loss is reported (with a reload of the durable state) and a
 * terminal failure clears only the processing indicator. Pure helpers plus a
 * server render of the chat panel; no browser.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../ChatPanel';
import { LIVE_CONNECTION_LOST_MESSAGE, liveConnectionLost, nextProcessingAgents } from '../live-updates';
import type { ClientNotification } from '../../../src/core/contracts/notifications';

const CONNECTING = 0;
const CLOSED = 2;

describe('liveConnectionLost (KAN-30)', () => {
  it('reports a closed stream at once, and a dropped one only when the reconnection fails too', () => {
    expect(liveConnectionLost(CLOSED, 1)).toBe(true);
    expect(liveConnectionLost(CONNECTING, 1)).toBe(false);
    expect(liveConnectionLost(CONNECTING, 2)).toBe(true);
  });
});

describe('nextProcessingAgents (KAN-30)', () => {
  const event = (kind: ClientNotification['kind']) => ({ kind, agentId: 'logo-agent' }) as ClientNotification;

  it('turns the indicator on when the worker claims the task and off on completion or terminal failure', () => {
    const processing = nextProcessingAgents(new Set(), event('task_processing'));
    expect([...processing]).toEqual(['logo-agent']);
    expect(nextProcessingAgents(processing, event('task_processing'))).toBe(processing);
    expect([...nextProcessingAgents(processing, event('task_failed'))]).toEqual([]);
    expect([...nextProcessingAgents(processing, event('task_completed'))]).toEqual([]);
    const idle = new Set<string>();
    expect(nextProcessingAgents(idle, event('task_failed'))).toBe(idle);
  });
});

describe('ChatPanel live connection banner (KAN-30)', () => {
  const render = (liveConnectionLost: boolean) =>
    renderToStaticMarkup(
      <ChatPanel
        assets={{ name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' }}
        processingAgents={new Set(['logo-agent'])}
        conversationId="11111111-1111-4111-8111-111111111111"
        handleExportConversation={vi.fn()}
        step={1}
        setShowRestartModal={vi.fn()}
        messages={[]}
        isLoading={false}
        messagesEndRef={{ current: null }}
        conversationError=""
        retryTurn={null}
        submitTurn={vi.fn()}
        inputText=""
        setInputText={vi.fn()}
        handleKeyDown={vi.fn()}
        handleSend={vi.fn()}
        needsNewConversation={false}
        liveConnectionLost={liveConnectionLost}
      />,
    );

  it('shows the loss with a «Recargar» button and keeps the chat input usable', () => {
    const html = render(true);
    expect(LIVE_CONNECTION_LOST_MESSAGE).toBe('Se perdió la conexión en vivo. Recarga para ver el estado actual.');
    expect(html).toContain(LIVE_CONNECTION_LOST_MESSAGE);
    expect(html).toMatch(/<button type="button"[^>]*>Recargar<\/button>/);
    expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain('disabled');
  });

  it('shows nothing while the stream is live', () => {
    expect(render(false)).not.toContain('Recargar');
  });
});
