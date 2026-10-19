import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  loggerFor: () => ({ child: () => ({ warn: vi.fn() }) }),
}));

import { GET } from '../route';

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
      payload: { type: 'agent_completed', agentId: 'logo-agent', artifacts: [] },
    }]);
    const response = await GET(new NextRequest('http://localhost/api/agents/stream?conversationId=00000000-0000-4000-8000-000000000001'));
    const reader = response.body!.getReader();
    await reader.read();
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toContain('event: artifact');
    expect(mocks.ackEvent).toHaveBeenCalledWith({ eventId: 'task-1:announce_completion' });
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
