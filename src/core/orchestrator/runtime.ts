/**
 * Production orchestrator singleton.
 *
 * Builds (and caches) the `Runtime` for the process — registry, Postgres
 * store, agent transport (Redis when REDIS_URL is set, an in-process bus otherwise),
 * notifier singletons, and the chat input/output adapters. The wiring lives
 * in `./runtime-config` (`buildRuntime`); this file is just the env-driven
 * factory + the `globalThis` cache.
 *
 * Transport selection (architecture §2.5):
 *   - When `REDIS_URL` is set, dispatches for `logo-agent`, `name-agent` and
 *     `tagline-agent` go via RedisQueueAdapter — the orchestrator publishes only the task id
 *     to `mypes:agent_task:dispatch:<agentId>`, the agent's in-process worker
 *     re-reads the canonical row from Postgres, runs the handler, and
 *     calls back into core.onTaskSettled. Other agents fall through to
 *     LocalAdapter until they are migrated.
 *   - When Redis is unavailable, the same workers drain an in-process
 *     wake-up bus (single-process dev/test only), so a settled task still
 *     gets its deliverables and durable outbox notice (KAN-82).
 *
 * Notifier singletons come from `./notifiers` (Redis-backed when REDIS_URL
 * is set, in-process otherwise — Phase 1).
 *
 * Cached on `globalThis` so that multiple Next.js server bundles (server
 * actions, route handlers, RSC) that each evaluate this module observe the
 * same Runtime — and therefore the same OrchestratorCoreImpl,
 * conversationTenants map, and notifier deps. Without this, a chatAction
 * publish would never reach an SSE subscriber set up in a different bundle.
 *
 * Due pending Redis tasks are republished after startup and on a periodic
 * scan. An `in_progress` task is never replayed automatically because an
 * external image request may already have completed.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Redis as RedisClient } from 'ioredis';
import { repos, systemRepos } from '../../repos';
import { globalRepos } from '../../repos/global';
import { getConversationOwnerUserId } from '../../repos/conversations';
import { LocalAdapter } from '../../transport/local-adapter';
import { dispatchWakeUp, RedisQueueAdapter } from '../../transport/redis-queue-adapter';
import { LOGO_WORKER, NAME_WORKER, TAGLINE_WORKER, startAgentWorker } from '../../workers/agent-worker';
import { getRedisPublisher, getRedisSubscriber } from '../../services/redis';
import type { AgentId, ConversationId, TaskId, UUID } from '../contracts';
import type { IAgentTransport } from '../agent-types';
import { buildDefaultRegistry } from './bootstrap-registry';
import { PostgresConversationStore } from './postgres-store';
import { PostgresDeliverableWorkflowStore } from './postgres-workflow';
import { createPostgresApprovalStore } from '../../repos/approval-store';
import { createOwnApproval } from '../../services/own-approval';
import type { IApprovalStore } from '../approvals';
import {
  defaultArtifactNotifier,
  defaultDecisionNotifier,
  defaultLifecycleNotifier,
} from './notifiers';
import { loggerFor } from '../../services/logger';
import { activePromptVersions, resolvePinnedPrompt, type PromptKey } from '../../services/prompts';
import { buildRuntime, type OnTaskSettled, type Runtime } from './runtime-config';
import { republishPendingDispatches, startPeriodicRecovery } from './periodic-recovery';
import type { ChatInputAdapter } from '../../adapters/chat-input-adapter';
import type { ChatOutputAdapter } from '../../adapters/chat-output-adapter';
import type { OrchestratorCoreImpl } from './orchestrator-core';

const log = loggerFor('orchestrator.runtime');

/** Agents with a Redis worker; the worker persists their deliverables (§2.5). */
const REDIS_WORKERS = [LOGO_WORKER, NAME_WORKER, TAGLINE_WORKER] as const;
const REDIS_DISPATCH_AGENTS: ReadonlySet<AgentId> = new Set(REDIS_WORKERS.map((worker) => worker.agentId));

// Cached on globalThis so that multiple Next.js server bundles observe the
// same Runtime instance.
const RUNTIME_SLOT = Symbol.for('mypes.orchestrator.runtime');
const RECOVERY_STOP_SLOT = Symbol.for('mypes.orchestrator.pending_recovery_stop');
type RuntimeHolder = { [RUNTIME_SLOT]?: Runtime };
const runtimeHolder = globalThis as unknown as RuntimeHolder;
type RecoveryHolder = { [RECOVERY_STOP_SLOT]?: () => void };
const recoveryHolder = globalThis as unknown as RecoveryHolder;

// Conservative, reversible local baseline. Production sizing and ownership
// remain open pending the pilot topology decision.
const PENDING_RECOVERY_INTERVAL_MS = 60_000;
const PENDING_RECOVERY_BATCH_SIZE = 100;

/**
 * Stands in for Redis Pub/Sub inside one process: the worker subscribes and
 * `RedisQueueAdapter` publishes exactly as they would over Redis.
 */
function inProcessWakeUpBus(): { publisher: RedisClient; subscriber: RedisClient } {
  const bus = new EventEmitter();
  const channels = new Set<string>();
  const subscriber = Object.assign(bus, {
    subscribe: async (channel: string) => channels.add(channel).size,
    unsubscribe: async (channel: string) => Number(channels.delete(channel)),
  });
  const publisher = {
    publish: async (channel: string, message: string) => {
      bus.emit('message', channel, message);
      return Number(channels.has(channel));
    },
  };
  return { publisher: publisher as unknown as RedisClient, subscriber: subscriber as unknown as RedisClient };
}

/** Exported for tests. */
export function buildTransport(
  registry: ReturnType<typeof buildDefaultRegistry>,
  onTaskSettled: OnTaskSettled,
): IAgentTransport {
  // LocalAdapter doesn't persist deliverables; supply [] for the third arg.
  // Return the settlement promise so the adapter awaits it and contains failures.
  const local = new LocalAdapter(registry, (taskId, state) =>
    onTaskSettled(taskId, state, []),
  );

  const redisPublisher = getRedisPublisher();
  const redisSubscriber = getRedisSubscriber();
  // Without Redis the same workers run over an in-process bus, so settlement
  // is the worker's durable one: deliverables and outbox notice (KAN-82).
  const { publisher, subscriber } =
    redisPublisher && redisSubscriber
      ? { publisher: redisPublisher, subscriber: redisSubscriber }
      : inProcessWakeUpBus();
  if (!redisPublisher || !redisSubscriber) {
    log.warn('orchestrator.runtime.transport.in_process_bus_no_redis');
  }

  // Boot the per-agent workers that drain the Redis dispatch channels.
  // Fire-and-forget: subscribe failures are logged inside the worker;
  // runtime construction must not block on Redis I/O.
  const workerContext = {
    subscriber,
    registry,
    systemReposFor: systemRepos,
    resolveConversationOwner: (tenantId: UUID, conversationId: ConversationId) =>
      getConversationOwnerUserId({ id: tenantId }, conversationId),
    // D22: first read pins the active versions of a conversation that predates the pin.
    pinnedPromptFor: async (tenantId: UUID, conversationId: ConversationId, agentId: AgentId) => {
      const userId = await getConversationOwnerUserId({ id: tenantId }, conversationId);
      if (!userId) return undefined;
      const pinned = await repos({ id: tenantId }, { id: userId }).conversationPrompts.pin(conversationId, activePromptVersions());
      return resolvePinnedPrompt(agentId as PromptKey, pinned);
    },
    deliverablesFor: (tenantId: UUID, userId: UUID) =>
      repos({ id: tenantId }, { id: userId }).deliverables,
    settleTaskFor: (tenantId: UUID, userId: UUID) =>
      repos({ id: tenantId }, { id: userId }).aiTurns,
    onTaskSettled,
    lifecycleNotifier: defaultLifecycleNotifier,
  };
  void Promise.all(REDIS_WORKERS.map((worker) => startAgentWorker(workerContext, worker))).then(() => {
    if (!recoveryHolder[RECOVERY_STOP_SLOT]) {
      recoveryHolder[RECOVERY_STOP_SLOT] = startPeriodicRecovery({
        intervalMs: PENDING_RECOVERY_INTERVAL_MS,
        recover: () => reconcileConfiguredTenantEvents(publisher),
        onError: (err) => log.error({ err }, 'orchestrator.runtime.periodic_recovery_failed'),
      });
    }
  }).catch((err: unknown) =>
    log.error({ err }, 'orchestrator.runtime.agent_worker_boot_failed'),
  );

  log.info(
    { redisAgents: [...REDIS_DISPATCH_AGENTS] },
    'orchestrator.runtime.transport.redis_queue',
  );
  return new RedisQueueAdapter({
    publisher,
    redisAgents: REDIS_DISPATCH_AGENTS,
    fallback: local,
  });
}

async function reconcileConfiguredTenantEvents(publisher: RedisClient): Promise<void> {
  const organizations = await globalRepos().organizations.list();
  const tenantIds = organizations.filter((organization) => organization.status === 'active').map((organization) => organization.tenantId);
  await Promise.all(tenantIds.map(async (tenantId) => {
    try {
      const tenantRepositories = systemRepos({ id: tenantId as UUID });
      await tenantRepositories.aiEvents?.reconcileSettledTasks({ limit: 500 });
      for (const agentId of REDIS_DISPATCH_AGENTS) {
        const republished = await republishPendingDispatches({
          tenantId: tenantId as UUID,
          agentId,
          batchSize: PENDING_RECOVERY_BATCH_SIZE,
          listPending: (input) => tenantRepositories.agentTasks.listPendingDispatches(input),
          publish: (task, taskTenantId) => {
            const wakeUp = dispatchWakeUp({ taskId: task.id, tenantId: taskTenantId, agentId: task.agentId as AgentId });
            return publisher.publish(wakeUp.channel, wakeUp.message);
          },
        });
        if (republished > 0) {
          log.info({ tenantId, agentId, republished, limit: PENDING_RECOVERY_BATCH_SIZE }, 'orchestrator.runtime.pending_tasks_republished');
        }
      }
    } catch (err) {
      log.error({ tenantId, err }, 'orchestrator.runtime.tenant_reconcile_failed');
    }
  }));
}

/**
 * The single approval-store wiring point: the KAN-34 Postgres store
 * (append-only approval history + stale-mark events written in one
 * transaction per approval, src/repos/approval-store.ts). Its persisted stale
 * marks reach the state function as `markedStaleKinds` (see
 * `loadWorkflowFacts` in ./deliverable-commands.ts).
 */
function createApprovalStore(tenantId: UUID, userId: UUID): IApprovalStore {
  const tenant = { id: tenantId };
  const user = { id: userId };
  // KAN-89: «Usar mi nombre / logo / lema» stores a user-origin version, then approves it like any other.
  return { ...createPostgresApprovalStore(tenant, user), approveOwn: createOwnApproval(tenant, user) };
}

function build(): Runtime {
  const registry = buildDefaultRegistry();
  const store = new PostgresConversationStore(registry.getFieldSchemas());

  return buildRuntime({
    registry,
    store,
    newTaskId: () => randomUUID() as TaskId,
    decisionNotifier: defaultDecisionNotifier,
    artifactNotifier: defaultArtifactNotifier,
    workflowFor: (tenantId: UUID, userId: UUID) => new PostgresDeliverableWorkflowStore(tenantId, userId),
    approvalsFor: createApprovalStore,
    transportFactory: (onTaskSettled) => buildTransport(registry, onTaskSettled),
  });
}

function getRuntime(): Runtime {
  const existing = runtimeHolder[RUNTIME_SLOT];
  if (existing) return existing;
  const next = build();
  runtimeHolder[RUNTIME_SLOT] = next;
  return next;
}

export function getOrchestrator(): OrchestratorCoreImpl {
  return getRuntime().core;
}

export function getChatInputAdapter(): ChatInputAdapter {
  return getRuntime().chatInputAdapter;
}

export function getChatOutputAdapter(): ChatOutputAdapter {
  return getRuntime().chatOutputAdapter;
}

/** Test hook: drop the cached runtime so the next getter rebuilds. */
export function resetOrchestratorRuntime(): void {
  delete runtimeHolder[RUNTIME_SLOT];
  recoveryHolder[RECOVERY_STOP_SLOT]?.();
  delete recoveryHolder[RECOVERY_STOP_SLOT];
}
