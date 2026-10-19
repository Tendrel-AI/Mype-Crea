/**
 * Production orchestrator singleton.
 *
 * Builds (and caches) the `Runtime` for the process — registry, Postgres
 * store, agent transport (Redis when REDIS_URL is set, Local otherwise),
 * notifier singletons, and the chat input/output adapters. The wiring lives
 * in `./runtime-config` (`buildRuntime`); this file is just the env-driven
 * factory + the `globalThis` cache.
 *
 * Transport selection (architecture §2.5):
 *   - When `REDIS_URL` is set, dispatches for `logo-agent` go via
 *     RedisQueueAdapter — the orchestrator publishes only the task id to
 *     `mypes:agent_task:dispatch:logo-agent`, the in-process worker
 *     re-reads the canonical row from Postgres, runs the handler, and
 *     calls back into core.onTaskSettled. Other agents fall through to
 *     LocalAdapter until they are migrated.
 *   - When Redis is unavailable, every dispatch uses the LocalAdapter
 *     (single-process dev/test only).
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
 * TODO(arch §2.5): the in-memory `conversationTenants` map inside the core
 * does not survive process restarts, so an in-flight task settling after a
 * restart drops silently. The proper fix is the architecture's sweeper +
 * persisted PlannerDecision rows, neither of which exists yet.
 */
import { randomUUID } from 'node:crypto';
import { repos, systemRepos } from '../../repos';
import { getConversationOwnerUserId } from '../../repos/conversations';
import { LocalAdapter } from '../../transport/local-adapter';
import { channelForAgent, RedisQueueAdapter } from '../../transport/redis-queue-adapter';
import { startLogoAgentWorker } from '../../workers/logo-agent-worker';
import { getRedisPublisher, getRedisSubscriber } from '../../services/redis';
import type { AgentId, ConversationId, TaskId, UUID } from '../contracts';
import type { IAgentTransport } from '../agent-types';
import { buildDefaultRegistry } from './bootstrap-registry';
import { PostgresConversationStore } from './postgres-store';
import {
  defaultArtifactNotifier,
  defaultDecisionNotifier,
  defaultLifecycleNotifier,
} from './notifiers';
import { loggerFor } from '../../services/logger';
import { buildRuntime, type OnTaskSettled, type Runtime } from './runtime-config';
import type { ChatInputAdapter } from '../../adapters/chat-input-adapter';
import type { ChatOutputAdapter } from '../../adapters/chat-output-adapter';
import type { OrchestratorCoreImpl } from './orchestrator-core';

const log = loggerFor('orchestrator.runtime');

const REDIS_DISPATCH_AGENTS: ReadonlySet<AgentId> = new Set([
  'logo-agent' as AgentId,
]);

// Cached on globalThis so that multiple Next.js server bundles observe the
// same Runtime instance.
const RUNTIME_SLOT = Symbol.for('mypes.orchestrator.runtime');
type RuntimeHolder = { [RUNTIME_SLOT]?: Runtime };
const runtimeHolder = globalThis as unknown as RuntimeHolder;

function buildTransport(
  registry: ReturnType<typeof buildDefaultRegistry>,
  onTaskSettled: OnTaskSettled,
): IAgentTransport {
  // LocalAdapter doesn't persist deliverables; supply [] for the third arg.
  const local = new LocalAdapter(registry, (taskId, state) => {
    onTaskSettled(taskId, state, []);
  });

  const publisher = getRedisPublisher();
  const subscriber = getRedisSubscriber();

  if (!publisher || !subscriber) {
    log.warn('orchestrator.runtime.transport.local_only_no_redis');
    return local;
  }

  // Boot the per-agent workers that drain the Redis dispatch channels.
  // Fire-and-forget: subscribe failures are logged inside the worker;
  // runtime construction must not block on Redis I/O.
  void startLogoAgentWorker({
    subscriber,
    registry,
    systemReposFor: systemRepos,
    resolveConversationOwner: (tenantId: UUID, conversationId: ConversationId) =>
      getConversationOwnerUserId({ id: tenantId }, conversationId),
    deliverablesFor: (tenantId: UUID, userId: UUID) =>
      repos({ id: tenantId }, { id: userId }).deliverables,
    settleTaskFor: (tenantId: UUID, userId: UUID) =>
      repos({ id: tenantId }, { id: userId }).aiTurns,
    onTaskSettled,
    lifecycleNotifier: defaultLifecycleNotifier,
  }).then(() => reconcileConfiguredTenantEvents()).catch((err) =>
    log.error({ err }, 'orchestrator.runtime.logo_worker_boot_failed'),
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

async function reconcileConfiguredTenantEvents(): Promise<void> {
  const raw = process.env.WORKOS_ORGANIZATION_TENANTS;
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.error('orchestrator.runtime.tenant_map_invalid_for_event_reconcile');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const tenantIds = [...new Set(Object.values(parsed))]
    .filter((value): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
  const publisher = getRedisPublisher();
  await Promise.all(tenantIds.map(async (tenantId) => {
    try {
      const tenantRepositories = systemRepos({ id: tenantId as UUID });
      await tenantRepositories.aiEvents?.reconcileSettledTasks({ limit: 500 });
      if (!publisher) return;
      const pending = await tenantRepositories.agentTasks.listPendingDispatches({
        agentId: 'logo-agent',
        limit: 500,
      });
      await Promise.all(pending.map(async (task) => {
        await publisher.publish(channelForAgent(task.agentId as AgentId), JSON.stringify({
          taskId: task.id,
          tenantId,
          agentId: task.agentId,
        }));
      }));
    } catch (err) {
      log.error({ tenantId, err }, 'orchestrator.runtime.startup_reconcile_failed');
    }
  }));
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
    agentTasksFor: (tenantId: UUID) => systemRepos({ id: tenantId }).agentTasks,
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
}
