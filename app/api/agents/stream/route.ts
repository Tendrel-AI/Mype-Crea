/**
 * Server-Sent Events stream of agent artifacts for a single conversation.
 *
 *   GET /api/agents/stream?conversationId=<uuid>
 *
 * Subscribes the caller to the in-process artifact notifier (singleton in
 * src/core/orchestrator/notifiers.ts) for the requested conversation. Every
 * artifact published by the orchestrator after a task settles is forwarded
 * as an `event: artifact` SSE frame whose `data` is the serialized
 * ArtifactPublishedEvent.
 *
 * Auth + tenant scoping: resolveIdentity() runs WorkOS, repos(...).conversations.get()
 * returns the row (or undefined under RLS if the conversation belongs to a
 * different tenant). 404 in either case.
 *
 * Lifetime: a 15-second comment heartbeat keeps the connection alive across
 * proxies. When the client disconnects, ReadableStream.cancel() fires and we
 * drop the subscription + clear the heartbeat.
 *
 * Process locality: this only works while the SSE handler and the
 * orchestrator dispatch live in the same Node process. When that breaks
 * (multi-instance prod), swap InProcessArtifactNotifier for a Postgres
 * LISTEN/NOTIFY or Redis pub/sub-backed implementation; nothing else here
 * changes.
 */
import type { NextRequest } from 'next/server';
import { resolveIdentity } from '../../../../src/auth/resolve-identity';
import { repos } from '../../../../src/repos';
import {
  defaultArtifactNotifier,
  defaultLifecycleNotifier,
} from '../../../../src/core/orchestrator/notifiers';
import { loggerFor } from '../../../../src/services/logger';
import type { ConversationId } from '../../../../src/core/contracts';
import type { ArtifactPublishedEvent } from '../../../../src/core/orchestrator/artifact-notifier';
import type { AgentTaskProcessingEvent } from '../../../../src/core/orchestrator/agent-lifecycle-notifier';

const log = loggerFor('controller.agents-stream');
const HEARTBEAT_MS = 15_000;

export async function GET(request: NextRequest): Promise<Response> {
  const conversationId = request.nextUrl.searchParams.get('conversationId') as
    | ConversationId
    | null;
  log.info(
    { conversationId, hasConversationId: Boolean(conversationId) },
    'agents.stream.request_received',
  );
  if (!conversationId) {
    return new Response('Missing conversationId', { status: 400 });
  }

  let tenant;
  let user;
  try {
    ({ tenant, user } = await resolveIdentity());
  } catch (err) {
    log.error({ err, conversationId }, 'agents.stream.resolve_identity_failed');
    return new Response('Unauthorized', { status: 401 });
  }
  log.info(
    { tenantId: tenant.id, userId: user.id, conversationId },
    'agents.stream.identity_resolved',
  );

  // The browser's EventSource opens at page mount, before chatAction has had
  // a chance to create the conversation row. If we 404 here, the EventSource
  // closes permanently (the WHATWG spec only auto-reconnects on network
  // errors, never on HTTP error responses) and any artifact published later
  // lands on a Redis channel with zero subscribers. Use getOrCreate so the
  // SSE handler is self-sufficient: row is created in the current tenant if
  // missing; if an id collision exists in a different tenant, RLS hides the
  // row and getOrCreate throws, preserving the cross-tenant auth check.
  try {
    await repos(tenant, user).conversations.getOrCreate(conversationId, []);
  } catch (err) {
    log.warn(
      { tenantId: tenant.id, userId: user.id, conversationId, err },
      'agents.stream.conversation_unavailable',
    );
    return new Response('Not found', { status: 404 });
  }
  log.info(
    { tenantId: tenant.id, userId: user.id, conversationId },
    'agents.stream.conversation_ready',
  );

  const child = log.child({
    tenantId: tenant.id,
    userId: user.id,
    conversationId,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const onArtifact = (event: ArtifactPublishedEvent): void => {
        const payload = JSON.stringify(event);
        child.info(
          {
            agentId: event.agentId,
            taskId: event.taskId,
            artifactCount: event.artifacts.length,
          },
          'agents.stream.artifact_received',
        );
        try {
          controller.enqueue(encoder.encode(`event: artifact\ndata: ${payload}\n\n`));
          child.info(
            { agentId: event.agentId, taskId: event.taskId },
            'agents.stream.artifact_forwarded',
          );
        } catch (err) {
          child.error({ err }, 'agents.stream.enqueue_failed');
        }
      };
      const artifactSubscription = defaultArtifactNotifier.subscribe(
        conversationId,
        onArtifact,
      );
      child.info(
        { notifierClass: defaultArtifactNotifier.constructor.name },
        'agents.stream.artifact_subscribed',
      );

      const onProcessing = (event: AgentTaskProcessingEvent): void => {
        const payload = JSON.stringify(event);
        try {
          controller.enqueue(
            encoder.encode(`event: task_processing\ndata: ${payload}\n\n`),
          );
        } catch (err) {
          child.error({ err }, 'agents.stream.enqueue_failed');
        }
      };
      const lifecycleSubscription = defaultLifecycleNotifier.subscribeProcessing(
        conversationId,
        onProcessing,
      );

      // Initial comment frame so curl/browsers see something immediately.
      controller.enqueue(encoder.encode(`: connected ${new Date().toISOString()}\n\n`));

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
        } catch {
          // The stream closed under us; cancel cleanup will run separately.
        }
      }, HEARTBEAT_MS);

      child.info('agents.stream.opened');

      // The cancel handler closes over these so we can dispose cleanly.
      (this as unknown as { _dispose: () => void })._dispose = () => {
        artifactSubscription.dispose();
        lifecycleSubscription.dispose();
        if (heartbeat) clearInterval(heartbeat);
        child.info('agents.stream.closed');
      };
    },
    cancel() {
      const dispose = (this as unknown as { _dispose?: () => void })._dispose;
      dispose?.();
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
