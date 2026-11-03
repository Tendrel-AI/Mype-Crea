/**
 * MYPES Platform — Agent worker (Redis-dispatched agents)
 * =======================================================
 *
 * Subscribes to one agent's dispatch channel published by RedisQueueAdapter
 * and runs that agent's registered handler against the authoritative
 * agent_tasks row from Postgres (architecture §2.5). One worker per entry of
 * `REDIS_DISPATCH_AGENTS` (runtime.ts): `LOGO_WORKER`, `NAME_WORKER` (KAN-31),
 * `TAGLINE_WORKER` (KAN-32).
 *
 * Flow per wake-up:
 *   1. Receive `{ taskId, tenantId }` on `mypes:agent_task:dispatch:<agentId>`.
 *   2. Re-read the canonical row from Postgres (tenant-scoped via repos).
 *      The notification is a trigger, not a payload — never trusted.
 *   3. Skip rows addressed to another agent without touching them, so they
 *      stay `pending` for their owner. Otherwise atomically claim the row
 *      (`pending` -> `in_progress`, conditional on `agent_id`); skip if it's
 *      already been claimed by a peer worker or moved past pending.
 *   4. Build an A2AMessage from the row, invoke the registry's handler.
 *   5. Copy generated images into the private bucket (KAN-52) BEFORE the
 *      durable settlement; a storage failure fails the task durably
 *      (`storage_unavailable`, transient) and no deliverable is written.
 *      Text artifacts (no URL) pass through unchanged.
 *   6. Hand the resulting TaskState back to OrchestratorCoreImpl.onTaskSettled,
 *      which is the same callback LocalAdapter uses — so the rest of the
 *      pipeline (markCompleted/markFailed, artifact pub/sub, SSE -> UI)
 *      is unchanged.
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
import { parseNotification } from '../core/contracts/notifications';
import { classifyTaskError, taskErrorFromThrown } from '../core/task-errors';
import { splitRequirementsSnapshot } from '../core/refinement';
import { loggerFor, type Logger } from '../services/logger';
import type { DeliverableKind } from '../repos/models';
import { storeArtifactImages } from '../services/storage/artifact-store';
import type { StoredArtifact } from '../services/storage/types';
import { clientDeliverableUrl } from '../core/deliverable-url';
import type { DeliverablesRepoLike, WorkerContext } from './_kit';

export type { DeliverablesRepoLike } from './_kit';

/** Which agent a worker drains and the deliverable_kind it stores. */
export interface AgentWorkerSpec {
  readonly agentId: AgentId;
  readonly deliverableKind: DeliverableKind;
  /** Prefix of the worker's log events, e.g. `worker.logo`. */
  readonly logScope: string;
}

export const LOGO_WORKER: AgentWorkerSpec = { agentId: 'logo-agent' as AgentId, deliverableKind: 'logo', logScope: 'worker.logo' };
export const NAME_WORKER: AgentWorkerSpec = { agentId: 'name-agent' as AgentId, deliverableKind: 'business_name', logScope: 'worker.name' };
export const TAGLINE_WORKER: AgentWorkerSpec = { agentId: 'tagline-agent' as AgentId, deliverableKind: 'tagline', logScope: 'worker.tagline' };

export interface AgentWorkerHandle {
  /** Tear down the subscription and drop the message listener. */
  stop(): Promise<void>;
}

export function startLogoAgentWorker(deps: WorkerContext): Promise<AgentWorkerHandle> {
  return startAgentWorker(deps, LOGO_WORKER);
}

export async function startAgentWorker(
  deps: WorkerContext,
  spec: AgentWorkerSpec,
): Promise<AgentWorkerHandle> {
  const { agentId: AGENT_ID, deliverableKind, logScope } = spec;
  const log = loggerFor(`worker.${AGENT_ID}`);
  const channel = channelForAgent(AGENT_ID);

  const onMessage = async (incomingChannel: string, raw: string): Promise<void> => {
    if (incomingChannel !== channel) return;

    log.info(
      { channel: incomingChannel, payloadBytes: raw.length },
      `${logScope}.notification_received`,
    );

    const wakeUp = parseNotification(raw, ['task_dispatch']);
    if (!wakeUp.ok) {
      log.error(
        { channel: incomingChannel, reason: wakeUp.reason, detail: wakeUp.detail },
        `${logScope}.parse_failed`,
      );
      return;
    }
    const parsed: DispatchNotification = wakeUp.notification;

    const { taskId, tenantId } = parsed;
    const child = log.child({ tenantId, taskId, agentId: AGENT_ID });
    child.info(
      { taskId, tenantId, agentId: parsed.agentId },
      `${logScope}.notification_parsed`,
    );

    const repo = deps.systemReposFor({ id: tenantId as UUID }).agentTasks;

    // Lookup the canonical row first so we can log what we found before we
    // mutate it. The notification is just a wake-up; Postgres is the source
    // of truth (architecture §2.5).
    let preClaim;
    try {
      preClaim = await repo.findById(taskId);
    } catch (err) {
      child.error({ err }, `${logScope}.lookup_failed`);
      return;
    }
    if (!preClaim) {
      child.warn(`${logScope}.row_not_found_in_db`);
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
      `${logScope}.row_loaded`,
    );

    // A task for another agent must stay claimable by its owner: never move
    // it to in_progress here. The claim below is also conditional on the
    // agent id, so this holds even if the row changed in between.
    if (preClaim.agentId !== AGENT_ID) {
      child.warn(
        { actualAgent: preClaim.agentId },
        `${logScope}.skip_wrong_agent_on_channel`,
      );
      return;
    }

    let claimed;
    try {
      claimed = await repo.claimById(taskId, AGENT_ID);
    } catch (err) {
      child.error({ err }, `${logScope}.claim_failed`);
      return;
    }
    if (!claimed) {
      child.info(
        { statusBeforeClaim: preClaim.status },
        `${logScope}.skip_not_claimable`,
      );
      return;
    }
    child.info(
      {
        statusAfterClaim: claimed.status,
        attempts: claimed.attempts,
        dispatchedAt: claimed.dispatchedAt,
      },
      `${logScope}.claimed`,
    );

    // Publish a lifecycle event so the UI shows a spinner immediately. This
    // happens BEFORE the handler runs so the user sees feedback even if the
    // image generation takes several seconds.
    const claimedAt = new Date().toISOString();
    if (deps.lifecycleNotifier) {
      try {
        deps.lifecycleNotifier.publishProcessing({
          conversationId: claimed.conversationId,
          agentId: AGENT_ID,
          taskId: claimed.id,
          claimedAt,
        });
        child.info({ claimedAt }, `${logScope}.lifecycle_published`);
      } catch (err) {
        child.error({ err }, `${logScope}.lifecycle_publish_failed`);
      }
    }
    const entry = deps.registry.get(AGENT_ID);

    // KAN-28: an «Iterar» task carries its refinement under the reserved
    // `refinement` key; it goes to `iteration`, never into `requirements`.
    // KAN-32: approved upstream values (e.g. the approved name) go to `upstream`.
    const { requirements, refinement, upstream } = splitRequirementsSnapshot(claimed.requirementsSnapshot);
    const a2a: A2AMessage = {
      taskId: claimed.id,
      tenantId: tenantId as UUID,
      agentId: AGENT_ID,
      agentCardVersion: claimed.agentCardVersion,
      requirements,
      ...(Object.keys(upstream).length > 0 ? { upstream } : {}),
      ...(claimed.parentTaskId
        ? {
            iteration: {
              parentTaskId: claimed.parentTaskId,
              ...(refinement && Object.keys(refinement.parameterChanges).length > 0
                ? { parameterChanges: refinement.parameterChanges }
                : {}),
              ...(refinement && refinement.observations.length > 0 ? { observations: refinement.observations } : {}),
              ...(refinement ? { anchorDeliverableId: refinement.anchorDeliverableId } : {}),
            },
          }
        : {}),
      createdAt: claimed.createdAt,
    };

    child.info(
      {
        iterationNumber: claimed.iterationNumber,
        iterationTrigger: claimed.iterationTrigger,
        observationCount: refinement?.observations.length ?? 0,
        requirementKeys: Object.keys(requirements),
        agentCardVersion: claimed.agentCardVersion,
      },
      `${logScope}.handler.start`,
    );

    const handlerStartedAt = Date.now();
    let result: A2ATaskResult;
    try {
      result = await entry.handler(a2a, entry.handlerDeps);
    } catch (err) {
      child.error({ err }, `${logScope}.handler.threw`);
      result = {
        status: 'failed',
        taskId: claimed.id,
        error: taskErrorFromThrown(err),
        completedAt: new Date().toISOString(),
      };
    }

    // KAN-52: the image goes into the private bucket before anything is
    // settled, so a deliverable row never exists without its stored object.
    let storedArtifacts: ReadonlyArray<StoredArtifact> = [];
    if (result.status === 'completed') {
      try {
        storedArtifacts = await (deps.storeArtifacts ?? storeArtifactImages)({
          tenantId,
          conversationId: claimed.conversationId,
          taskId: claimed.id,
          artifacts: result.artifacts,
        });
        child.info(
          { storedCount: storedArtifacts.filter((artifact) => artifact.storageKey).length },
          `${logScope}.assets_stored`,
        );
      } catch (err) {
        const error = taskErrorFromThrown(err);
        child.error({ err, errorKind: error.kind }, `${logScope}.asset_storage_failed`);
        result = { status: 'failed', taskId: claimed.id, error, completedAt: new Date().toISOString() };
      }
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
      `${logScope}.handler.settled`,
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
      child.error({ err }, `${logScope}.owner_lookup_failed`);
    }
    let durableSettlement = false;
    if (ownerUserId && deps.settleTaskFor) {
      try {
        const settled = await deps.settleTaskFor(tenantId as UUID, ownerUserId).settleTaskAndEnqueue({
          conversationId: claimed.conversationId,
          taskId: claimed.id,
          state: finalState.status,
          deliverableKind,
          artifacts: finalState.status === 'completed' ? storedArtifacts : [],
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
        child.error({ err, status: finalState.status }, `${logScope}.settlement_failed`);
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
          `${logScope}.owner_unresolved_skipping_persistence`,
        );
      } else {
        const repo = deps.deliverablesFor(tenantId as UUID, ownerUserId);
        deliverableIds = await persistArtifacts(
          repo,
          deliverableKind,
          log,
          logScope,
          claimed.id,
          claimed.conversationId,
          storedArtifacts,
          { tenantId: tenantId as UUID, conversationId: claimed.conversationId, taskId: claimed.id },
        );
      }
    }

    child.info(
      {
        deliverableCount: deliverableIds.length,
        status: finalState.status,
      },
      `${logScope}.on_settled.invoking`,
    );
    try {
      if (!ownerUserId) {
        throw new Error('Cannot settle task without verified conversation owner');
      }
      // Downstream (decisions, turn payloads, artifact events) only ever sees
      // client-safe URLs: a stored image becomes `/api/assets/<id>` (KAN-52).
      const settledState: TaskState =
        finalState.status === 'completed'
          ? {
              status: 'completed',
              result: { ...finalState.result, artifacts: clientArtifacts(storedArtifacts, deliverableIds) },
            }
          : finalState;
      await deps.onTaskSettled(claimed.id, settledState, deliverableIds, {
        tenantId: tenantId as UUID,
        conversationId: claimed.conversationId,
        ownerUserId,
        agentId: claimed.agentId,
        ...(durableSettlement ? { durableSettlement: true as const } : {}),
      });
      child.info(`${logScope}.on_settled.returned`);
    } catch (err) {
      child.error({ err }, `${logScope}.on_settled_threw`);
    }
  };

  // ioredis multiplexes 'message' across multiple subscriptions on the same
  // connection — RedisDecisionNotifier and RedisArtifactNotifier already
  // attach their own listeners. Each listener filters by channel name.
  deps.subscriber.on('message', onMessage);
  await deps.subscriber.subscribe(channel);

  log.info({ channel }, `${logScope}.subscribed`);

  return {
    async stop(): Promise<void> {
      deps.subscriber.off('message', onMessage);
      try {
        await deps.subscriber.unsubscribe(channel);
      } catch (err) {
        log.error({ err, channel }, `${logScope}.unsubscribe_failed`);
      }
      log.info({ channel }, `${logScope}.stopped`);
    },
  };
}

/**
 * The artifacts as a client may see them. Deliverable ids come back in the
 * order the persistable artifacts (URL or inline) were inserted; a stored
 * image is exposed only as its asset route, and loses its URL entirely if
 * no deliverable row exists for it. `storageKey` never leaves the worker.
 */
function clientArtifacts(
  artifacts: ReadonlyArray<StoredArtifact>,
  deliverableIds: ReadonlyArray<DeliverableId>,
): A2AArtifact[] {
  let position = 0;
  return artifacts.map(({ storageKey, ...artifact }) => {
    const persistable = Boolean(artifact.url) || artifact.inline !== undefined;
    const id = persistable ? deliverableIds[position++] : undefined;
    if (!storageKey) return artifact;
    const url = id ? clientDeliverableUrl({ id, contentUrl: artifact.url ?? null, storageKey }) : null;
    const { url: _providerUrl, ...rest } = artifact;
    return url ? { ...rest, url } : rest;
  });
}

async function persistArtifacts(
  repo: DeliverablesRepoLike,
  deliverableKind: DeliverableKind,
  log: Logger,
  logScope: string,
  taskId: TaskId,
  conversationId: ConversationId,
  artifacts: ReadonlyArray<StoredArtifact>,
  ctx: { tenantId: UUID; conversationId: ConversationId; taskId: TaskId },
): Promise<DeliverableId[]> {
  const ids: DeliverableId[] = [];
  for (const artifact of artifacts) {
    try {
      const inserted = await repo.insert({
        conversationId,
        agentTaskId: taskId,
        kind: deliverableKind,
        contentUrl: artifact.url ?? null,
        contentInline:
          artifact.url == null && artifact.inline !== undefined
            ? { value: artifact.inline, kind: artifact.kind }
            : null,
        storageKey: artifact.storageKey ?? null,
      });
      ids.push(inserted.id as DeliverableId);
      log.info(
        { ...ctx, deliverableId: inserted.id, hasUrl: Boolean(artifact.url) },
        `${logScope}.deliverable.persisted`,
      );
    } catch (err) {
      log.error({ ...ctx, err }, `${logScope}.deliverable.persist_failed`);
    }
  }
  return ids;
}
