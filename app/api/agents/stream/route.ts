/** Durable, owner-scoped event stream for an already-created conversation. */
import type { NextRequest } from 'next/server';
import { resolveIdentity, verifyActiveMembership } from '../../../../src/auth/resolve-identity';
import { repos } from '../../../../src/repos';
import { buildDefaultRegistry } from '../../../../src/core/orchestrator/bootstrap-registry';
import { defaultLifecycleNotifier } from '../../../../src/core/orchestrator/notifiers';
import { loggerFor } from '../../../../src/services/logger';
import type { ConversationId } from '../../../../src/core/contracts';
import type { AgentTaskProcessingEvent } from '../../../../src/core/orchestrator/agent-lifecycle-notifier';

const log = loggerFor('controller.agents-stream');
const HEARTBEAT_MS = 15_000;
const POLL_MS = 1_000;
const MEMBERSHIP_RECHECK_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest): Promise<Response> {
  const rawConversationId = request.nextUrl.searchParams.get('conversationId');
  if (!rawConversationId || !UUID_PATTERN.test(rawConversationId)) {
    return new Response('Invalid conversationId', { status: 400 });
  }
  const conversationId = rawConversationId as ConversationId;

  let identity;
  try {
    identity = await resolveIdentity();
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  const repository = repos(identity.tenant, identity.user);
  try {
    const pin = await repository.conversations.readPinnedConversation(
      conversationId,
      buildDefaultRegistry().getFieldSchemas(),
    );
    // SSE is read-only. It must never create a conversation or retroactively pin a legacy row.
    if (!pin) return new Response('Not found', { status: 404 });
    if (pin.state !== 'pinned') return new Response('Conversation configuration unavailable', { status: 409 });
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const child = log.child({
    tenantId: identity.tenant.id,
    userId: identity.user.id,
    conversationId,
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let polling = false;
      let authorized = true;
      let authCheck: Promise<boolean> | undefined;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let membershipTimer: ReturnType<typeof setInterval> | undefined;
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeat) clearInterval(heartbeat);
        if (membershipTimer) clearInterval(membershipTimer);
        lifecycleSubscription.dispose();
        try { controller.close(); } catch { /* already closed by consumer */ }
      };
      const checkMembership = async (): Promise<boolean> => {
        if (closed || !authorized) return false;
        if (!authCheck) {
          authCheck = verifyActiveMembership({
            organizationId: identity.organizationId,
            workosUserId: identity.workosUserId,
            tenantId: identity.tenant.id,
            userId: identity.user.id,
          }).catch(() => false).then((isActive) => {
            if (!isActive) {
              authorized = false;
              close();
            }
            return isActive;
          }).finally(() => { authCheck = undefined; });
        }
        return authCheck;
      };
      const send = (event: string, payload: unknown): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const onProcessing = (event: AgentTaskProcessingEvent): void => {
        void checkMembership().then((isActive) => {
          if (isActive) send('task_processing', event);
        });
      };
      const lifecycleSubscription = defaultLifecycleNotifier.subscribeProcessing(
        conversationId,
        onProcessing,
      );
      controller.enqueue(encoder.encode(`: connected ${new Date().toISOString()}\n\n`));

      const poll = async (): Promise<void> => {
        if (closed || polling) return;
        polling = true;
        try {
          if (!await checkMembership()) return;
          const events = await repository.aiTurns.peekEvents({ conversationId, limit: 50 });
          for (const event of events) {
            if (!await checkMembership()) break;
            const eventName = event.kind;
            // Ack follows enqueue. A disconnect or enqueue failure leaves the event available
            // for the next authorized connection.
            if (!send(eventName, event.payload)) break;
            await repository.aiTurns.ackEvent({ eventId: event.eventId });
          }
        } catch (error) {
          child.warn({ error }, 'agents.stream.event_poll_failed');
        } finally {
          polling = false;
        }
      };
      void poll();
      pollTimer = setInterval(() => void poll(), POLL_MS);
      heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
          } catch {
            closed = true;
          }
        }
      }, HEARTBEAT_MS);
      membershipTimer = setInterval(() => { void checkMembership(); }, MEMBERSHIP_RECHECK_MS);
      (this as unknown as { dispose: () => void }).dispose = () => {
        close();
      };
    },
    cancel() {
      (this as unknown as { dispose?: () => void }).dispose?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
