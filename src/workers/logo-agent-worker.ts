/**
 * MYPES Platform — Logo agent worker
 * ===================================
 *
 * Subscribes to the logo-agent dispatch channel published by
 * RedisQueueAdapter and runs the local handler against the
 * authoritative agent_tasks row from Postgres (architecture §2.5).
 *
 * Flow per wake-up:
 *   1. Receive `{ taskId, tenantId }` on `mypes:agent_task:dispatch:logo-agent`.
 *   2. Re-read the canonical row from Postgres (tenant-scoped via repos).
 *      The notification is a trigger, not a payload — never trusted.
 *   3. Skip rows addressed to another agent without touching them, so they
 *      stay `pending` for their owner. Otherwise atomically claim the row
 *      (`pending` -> `in_progress`, conditional on `agent_id`); skip if it's
 *      already been claimed by a peer worker or moved past pending.
 *   4. Build an A2AMessage from the row, invoke the registry's logo handler.
 *   5. Hand the resulting TaskState back to OrchestratorCoreImpl.onTaskSettled,
 *      which is the same callback LocalAdapter uses — so the rest of the
 *      pipeline (markCompleted/markFailed, artifact pub/sub, SSE -> UI)
 *      is unchanged.
 *
 * Phase-1 scope: this worker only handles `logo-agent`. The other agent
 * cards (`tagline`, `label`, `social`) keep running through the
 * LocalAdapter fallback in RedisQueueAdapter until they are migrated.
 *
 * Process locality: in Phase 1 the worker boots in the same Node process as
 * the orchestrator runtime (see runtime.ts). In Phase 2 the same module
 * runs as its own service; nothing in the contract changes.
 */
import type {
  A2AArtifact,
  A2AMessage,
  A2ATaskResult,
  TaskState,
} from '../core/agent-types';
import type { AgentId, ConversationId, DeliverableId, TaskId, UUID } from '../core/contracts';
import { channelForAgent } from '../transport/redis-queue-adapter';
import type { DispatchNotification } from '../transport/redis-queue-adapter';
import { classifyTaskError, taskErrorFromThrown } from '../core/task-errors';
import { loggerFor } from '../services/logger';
import type { DeliverablesRepoLike, WorkerContext } from './_kit';

export type { DeliverablesRepoLike } from './_kit';

const log = loggerFor('worker.logo-agent');

const LOGO_AGENT_ID = 'logo-agent' as AgentId;
/**
 * deliverable_kind for everything this worker produces. Hardcoded because
 * a worker is per-agent — generalizing this is the next worker's problem.
 */
const LOGO_DELIVERABLE_KIND = 'logo' as const;

/** Back-compat alias. New code should reference `WorkerContext` from `./_kit`. */
export type LogoAgentWorkerDeps = WorkerContext;

export interface LogoAgentWorkerHandle {
  /** Tear down the subscription and drop the message listener. */
  stop(): Promise<void>;
}

export async function startLogoAgentWorker(
  deps: WorkerContext,
): Promise<LogoAgentWorkerHandle> {
  const channel = channelForAgent(LOGO_AGENT_ID);

  const onMessage = async (incomingChannel: string, raw: string): Promise<void> => {
    if (incomingChannel !== channel) return;

    log.info(
      { channel: incomingChannel, payloadBytes: raw.length },
      'worker.logo.notification_received',
    );

    let parsed: DispatchNotification;
    try {
      parsed = JSON.parse(raw) as DispatchNotification;
    } catch (err) {
      log.error({ err, channel: incomingChannel, raw }, 'worker.logo.parse_failed');
      return;
    }

    const { taskId, tenantId } = parsed;
    const child = log.child({ tenantId, taskId, agentId: LOGO_AGENT_ID });
    child.info(
      { taskId, tenantId, agentId: parsed.agentId },
      'worker.logo.notification_parsed',
    );

    const repo = deps.systemReposFor({ id: tenantId as UUID }).agentTasks;

    // Lookup the canonical row first so we can log what we found before we
    // mutate it. The notification is just a wake-up; Postgres is the source
    // of truth (architecture §2.5).
    let preClaim;
    try {
      preClaim = await repo.findById(taskId);
    } catch (err) {
      child.error({ err }, 'worker.logo.lookup_failed');
      return;
    }
    if (!preClaim) {
      child.warn('worker.logo.row_not_found_in_db');
      return;
    }
    child.info(
      {
        statusBeforeClaim: preClaim.status,
        agentIdInRow: preClaim.agentId,
        conversationId: preClaim.conversationId,
        attempts: preClaim.attempts,
        iterationNumber: preClaim.iterationNumber,
        requirementKeys: Object.keys(preClaim.requirementsSnapshot),
      },
      'worker.logo.row_loaded',
    );

    // A task for another agent must stay claimable by its owner: never move
    // it to in_progress here. The claim below is also conditional on the
    // agent id, so this holds even if the row changed in between.
    if (preClaim.agentId !== LOGO_AGENT_ID) {
      child.warn(
        { actualAgent: preClaim.agentId },
        'worker.logo.skip_wrong_agent_on_channel',
      );
      return;
    }

    let claimed;
    try {
      claimed = await repo.claimById(taskId, LOGO_AGENT_ID);
    } catch (err) {
      child.error({ err }, 'worker.logo.claim_failed');
      return;
    }
    if (!claimed) {
      child.info(
        { statusBeforeClaim: preClaim.status },
        'worker.logo.skip_not_claimable',
      );
      return;
    }
    child.info(
      {
        statusAfterClaim: claimed.status,
        attempts: claimed.attempts,
        dispatchedAt: claimed.dispatchedAt,
      },
      'worker.logo.claimed',
    );

    // Publish a lifecycle event so the UI shows a spinner immediately. This
    // happens BEFORE the handler runs so the user sees feedback even if the
    // image generation takes several seconds.
    const claimedAt = new Date().toISOString();
    if (deps.lifecycleNotifier) {
      try {
        deps.lifecycleNotifier.publishProcessing({
          conversationId: claimed.conversationId,
          agentId: LOGO_AGENT_ID,
          taskId: claimed.id,
          claimedAt,
        });
        child.info({ claimedAt }, 'worker.logo.lifecycle_published');
      } catch (err) {
        child.error({ err }, 'worker.logo.lifecycle_publish_failed');
      }
    }
    const entry = deps.registry.get(LOGO_AGENT_ID);

    const a2a: A2AMessage = {
      taskId: claimed.id,
      tenantId: tenantId as UUID,
      agentId: LOGO_AGENT_ID,
      agentCardVersion: claimed.agentCardVersion,
      requirements: claimed.requirementsSnapshot,
      createdAt: claimed.createdAt,
    };

    child.info(
      {
        requirementKeys: Object.keys(claimed.requirementsSnapshot),
        agentCardVersion: claimed.agentCardVersion,
      },
      'worker.logo.handler.start',
    );

    const handlerStartedAt = Date.now();
    let result: A2ATaskResult;
    try {
      result = await entry.handler(a2a, entry.handlerDeps);
    } catch (err) {
      child.error({ err }, 'worker.logo.handler.threw');
      result = {
        status: 'failed',
        taskId: claimed.id,
        error: taskErrorFromThrown(err),
        completedAt: new Date().toISOString(),
      };
    }

    const finalState: TaskState =
      result.status === 'completed'
        ? { status: 'completed', result }
        : { status: 'failed', result };

    child.info(
      {
        status: finalState.status,
        durationMs: Date.now() - handlerStartedAt,
        artifactCount:
          finalState.status === 'completed' ? finalState.result.artifacts.length : 0,
      },
      'worker.logo.handler.settled',
    );

    // Persist artifacts as `deliverables` rows. This is the worker's
    // responsibility — the orchestrator never touches the deliverables
    // table; it just receives the resulting ids and threads them into
    // announce_completion.
    let deliverableIds: DeliverableId[] = [];
    let ownerUserId: UUID | null = null;
    try {
      ownerUserId = await deps.resolveConversationOwner(
        tenantId as UUID,
        claimed.conversationId,
      );
    } catch (err) {
      child.error({ err }, 'worker.logo.owner_lookup_failed');
    }
    let durableSettlement = false;
    if (ownerUserId && deps.settleTaskFor) {
      try {
        const settled = await deps.settleTaskFor(tenantId as UUID, ownerUserId).settleTaskAndEnqueue({
          conversationId: claimed.conversationId,
          taskId: claimed.id,
          state: finalState.status,
          deliverableKind: LOGO_DELIVERABLE_KIND,
          artifacts: finalState.status === 'completed' ? finalState.result.artifacts : [],
          ...(finalState.status === 'failed'
            ? {
                error: {
                  kind: finalState.result.error.kind,
                  message: finalState.result.error.message,
                },
                errorCategory: classifyTaskError(finalState.result.error),
              }
            : {}),
        });
        deliverableIds = settled.deliverableIds as DeliverableId[];
        durableSettlement = true;
      } catch (err) {
        // Nothing was committed: the row stays in_progress, which is the
        // operator review signal (architecture §2.5). Do not announce a
        // settlement that is not durable, and never reject the listener.
        child.error({ err, status: finalState.status }, 'worker.logo.settlement_failed');
        return;
      }
    } else if (
      finalState.status === 'completed' &&
      finalState.result.artifacts.length > 0 &&
      deps.deliverablesFor
    ) {
      if (!ownerUserId) {
        child.warn(
          { conversationId: claimed.conversationId },
          'worker.logo.owner_unresolved_skipping_persistence',
        );
      } else {
        const repo = deps.deliverablesFor(tenantId as UUID, ownerUserId);
        deliverableIds = await persistArtifacts(
          repo,
          claimed.id,
          claimed.conversationId,
          finalState.result.artifacts,
          { tenantId: tenantId as UUID, conversationId: claimed.conversationId, taskId: claimed.id },
        );
      }
    }

    child.info(
      {
        deliverableCount: deliverableIds.length,
        status: finalState.status,
      },
      'worker.logo.on_settled.invoking',
    );
    try {
      if (!ownerUserId) {
        throw new Error('Cannot settle task without verified conversation owner');
      }
      await deps.onTaskSettled(claimed.id, finalState, deliverableIds, {
        tenantId: tenantId as UUID,
        conversationId: claimed.conversationId,
        ownerUserId,
        agentId: claimed.agentId,
        ...(durableSettlement ? { durableSettlement: true as const } : {}),
      });
      child.info('worker.logo.on_settled.returned');
    } catch (err) {
      child.error({ err }, 'worker.logo.on_settled_threw');
    }
  };

  // ioredis multiplexes 'message' across multiple subscriptions on the same
  // connection — RedisDecisionNotifier and RedisArtifactNotifier already
  // attach their own listeners. Each listener filters by channel name.
  deps.subscriber.on('message', onMessage);
  await deps.subscriber.subscribe(channel);

  log.info({ channel }, 'worker.logo.subscribed');

  return {
    async stop(): Promise<void> {
      deps.subscriber.off('message', onMessage);
      try {
        await deps.subscriber.unsubscribe(channel);
      } catch (err) {
        log.error({ err, channel }, 'worker.logo.unsubscribe_failed');
      }
      log.info({ channel }, 'worker.logo.stopped');
    },
  };
}

async function persistArtifacts(
  repo: DeliverablesRepoLike,
  taskId: TaskId,
  conversationId: ConversationId,
  artifacts: ReadonlyArray<A2AArtifact>,
  ctx: { tenantId: UUID; conversationId: ConversationId; taskId: TaskId },
): Promise<DeliverableId[]> {
  const ids: DeliverableId[] = [];
  for (const artifact of artifacts) {
    try {
      const inserted = await repo.insert({
        conversationId,
        agentTaskId: taskId,
        kind: LOGO_DELIVERABLE_KIND,
        contentUrl: artifact.url ?? null,
        contentInline:
          artifact.url == null && artifact.inline !== undefined
            ? { value: artifact.inline, kind: artifact.kind }
            : null,
      });
      ids.push(inserted.id as DeliverableId);
      log.info(
        { ...ctx, deliverableId: inserted.id, hasUrl: Boolean(artifact.url) },
        'worker.logo.deliverable.persisted',
      );
    } catch (err) {
      log.error({ ...ctx, err }, 'worker.logo.deliverable.persist_failed');
    }
  }
  return ids;
}
