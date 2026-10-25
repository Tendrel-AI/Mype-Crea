import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  readPinnedConversation: vi.fn(),
  peekEvents: vi.fn(),
  ackEvent: vi.fn(),
  getFieldSchemas: vi.fn(() => []),
  subscribeProcessing: vi.fn((_conversationId: string, callback: (event: unknown) => void) => {
    mocks.processingCallback = callback;
    return { dispose: vi.fn() };
  }),
  verifyActiveMembership: vi.fn(),
  warn: vi.fn(),
  processingCallback: undefined as ((event: unknown) => void) | undefined,
}));

vi.mock('../../../../../src/auth/resolve-identity', () => ({
  resolveIdentity: mocks.resolveIdentity,
  verifyActiveMembership: mocks.verifyActiveMembership,
}));
vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth: vi.fn(),
  getWorkOS: vi.fn(),
}));
vi.mock('../../../../../src/repos', () => ({
  repos: () => ({
    conversations: { readPinnedConversation: mocks.readPinnedConversation },
    aiTurns: { peekEvents: mocks.peekEvents, ackEvent: mocks.ackEvent },
  }),
}));
vi.mock('../../../../../src/core/orchestrator/bootstrap-registry', () => ({
  buildDefaultRegistry: () => ({ getFieldSchemas: mocks.getFieldSchemas }),
}));
vi.mock('../../../../../src/core/orchestrator/notifiers', () => ({
  defaultLifecycleNotifier: { subscribeProcessing: mocks.subscribeProcessing },
}));
vi.mock('../../../../../src/services/logger', () => ({
  loggerFor: () => ({ child: () => ({ warn: mocks.warn }) }),
}));

import { GET } from '../route';
import { notification, notificationToJson } from '../../../../../src/core/contracts/notifications';

const STREAM_URL = 'http://localhost/api/agents/stream?conversationId=00000000-0000-4000-8000-000000000001';

function parseFrame(raw: string): { event: string | undefined; data: unknown; raw: string } {
  const event = /^event: (.+)$/m.exec(raw)?.[1];
  const data = /^data: (.+)$/m.exec(raw)?.[1];
  return { event, data: data ? JSON.parse(data) : undefined, raw };
}

describe('agents stream route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveIdentity.mockResolvedValue({
      tenant: { id: 'tenant-1' }, user: { id: 'user-1' },
      organizationId: 'org_123', workosUserId: 'user_123456789012345678901234',
    });
    mocks.verifyActiveMembership.mockResolvedValue(true);
    mocks.readPinnedConversation.mockResolvedValue({ state: 'pinned' });
    mocks.peekEvents.mockResolvedValue([]);
    mocks.ackEvent.mockResolvedValue(true);
  });

  it('rejects malformed and forged conversation identifiers before opening a stream', async () => {
    const malformed = await GET(new NextRequest('http://localhost/api/agents/stream?conversationId=not-a-uuid'));
    expect(malformed.status).toBe(400);
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();

    mocks.readPinnedConversation.mockResolvedValueOnce(undefined as never);
    const forged = await GET(new NextRequest('http://localhost/api/agents/stream?conversationId=00000000-0000-4000-8000-000000000001'));
    expect(mocks.resolveIdentity).toHaveBeenCalled();
    expect(forged.status).toBe(404);
    expect(mocks.readPinnedConversation).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', []);
    expect(mocks.peekEvents).not.toHaveBeenCalled();
  });

  it('refuses legacy rows and does not create or pin them', async () => {
    mocks.readPinnedConversation.mockResolvedValue({ state: 'legacy_unversioned' });
    const response = await GET(new NextRequest('http://localhost/api/agents/stream?conversationId=00000000-0000-4000-8000-000000000001'));
    expect(response.status).toBe(409);
    expect(mocks.peekEvents).not.toHaveBeenCalled();
  });

  it('acks a durable event only after writing it to the stream', async () => {
    mocks.peekEvents.mockResolvedValueOnce([{
      eventId: 'task-1:announce_completion',
      kind: 'artifact',
      payload: notificationToJson(notification('task_completed', {
        taskId: 'task-1', agentId: 'logo-agent', deliverableIds: [], artifacts: [],
      })),
    }]);
    const response = await GET(new NextRequest(STREAM_URL));
    const reader = response.body!.getReader();
    await reader.read();
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toContain('event: task_completed');
    expect(mocks.ackEvent).toHaveBeenCalledWith({ eventId: 'task-1:announce_completion' });
    await reader.cancel();
  });

  describe('failed-task detail is developer-only (KAN-58)', () => {
    const failedEvent = () => ({
      eventId: 'task-2:announce_failure',
      kind: 'notice',
      payload: notificationToJson(notification('task_failed', {
        taskId: 'task-2',
        agentId: 'logo-agent',
        detail: { errorCategory: 'content_policy', errorKind: 'content_policy', message: 'fal 422 content_policy_violation' },
      })),
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function firstFrame(): Promise<ReturnType<typeof parseFrame>> {
      mocks.peekEvents.mockResolvedValueOnce([failedEvent()]);
      const response = await GET(new NextRequest(STREAM_URL));
      const reader = response.body!.getReader();
      await reader.read(); // connected comment
      const frame = parseFrame(new TextDecoder().decode((await reader.read()).value));
      await reader.cancel();
      return frame;
    }

    it('forwards the technical detail when DEVELOPMENT=TRUE', async () => {
      vi.stubEnv('DEVELOPMENT', 'TRUE');
      const frame = await firstFrame();
      expect(frame.event).toBe('task_failed');
      expect(frame.data).toMatchObject({
        kind: 'task_failed',
        taskId: 'task-2',
        detail: { errorCategory: 'content_policy', errorKind: 'content_policy', message: 'fal 422 content_policy_violation' },
      });
      expect(mocks.ackEvent).toHaveBeenCalledWith({ eventId: 'task-2:announce_failure' });
    });

    it.each([undefined, 'false', ''])('strips it when DEVELOPMENT=%s, so no technical text reaches the browser', async (value) => {
      if (value !== undefined) vi.stubEnv('DEVELOPMENT', value);
      else vi.stubEnv('DEVELOPMENT', undefined as unknown as string);
      const frame = await firstFrame();
      expect(frame.event).toBe('task_failed');
      expect(frame.data).toEqual({ v: 1, kind: 'task_failed', taskId: 'task-2', agentId: 'logo-agent' });
      expect(frame.raw).not.toContain('content_policy');
    });
  });

  it('acks and skips a durable row that does not match the contract, then forwards the next one', async () => {
    mocks.peekEvents.mockResolvedValueOnce([
      { eventId: 'legacy:announce_completion', kind: 'artifact', payload: { type: 'agent_completed', agentId: 'logo-agent', artifacts: [] } },
      {
        eventId: 'task-3:announce_completion',
        kind: 'artifact',
        payload: notificationToJson(notification('task_completed', {
          taskId: 'task-3', agentId: 'logo-agent', deliverableIds: [], artifacts: [],
        })),
      },
    ]);
    const response = await GET(new NextRequest(STREAM_URL));
    const reader = response.body!.getReader();
    await reader.read();
    const frame = parseFrame(new TextDecoder().decode((await reader.read()).value));
    expect(frame.data).toMatchObject({ kind: 'task_completed', taskId: 'task-3' });
    expect(mocks.ackEvent).toHaveBeenNthCalledWith(1, { eventId: 'legacy:announce_completion' });
    expect(mocks.ackEvent).toHaveBeenNthCalledWith(2, { eventId: 'task-3:announce_completion' });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'legacy:announce_completion', reason: 'unsupported_version' }),
      'agents.stream.event_rejected',
    );
    await reader.cancel();
  });

  it('closes an open stream and suppresses live events when membership is revoked', async () => {
    const response = await GET(new NextRequest('http://localhost/api/agents/stream?conversationId=00000000-0000-4000-8000-000000000001'));
    const reader = response.body!.getReader();
    await reader.read(); // connected comment
    await vi.waitFor(() => expect(mocks.peekEvents).toHaveBeenCalled());
    const pollsBeforeRevocation = mocks.peekEvents.mock.calls.length;
    mocks.verifyActiveMembership.mockResolvedValueOnce(false);
    mocks.processingCallback?.({ taskId: 'task-1', conversationId: '00000000-0000-4000-8000-000000000001' });
    const closed = await reader.read();
    expect(closed.done).toBe(true);
    expect(mocks.peekEvents).toHaveBeenCalledTimes(pollsBeforeRevocation);
  });
});
