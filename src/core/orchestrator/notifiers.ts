/**
 * Module-level singletons for the notifier instances. Whoever instantiates
 * OrchestratorCoreImpl in production code passes these same singletons in as
 * deps so that subscribers (the SSE route, future websocket gateways) receive
 * every event the orchestrator publishes.
 *
 * Backed by Redis Pub/Sub when `REDIS_URL` is set (see
 * claude/skills/mypes-architecture/SKILL.md §2.5, §2.10), and by an
 * in-process EventEmitter otherwise — useful for local single-process
 * dev/tests where Redis is not available.
 *
 * The trio is cached on `globalThis` via a registry-keyed symbol so that
 * even when Next.js evaluates this module from multiple bundles (server
 * actions vs. route handlers vs. RSC) within the same Node process, every
 * caller observes the *same* notifier instances. Without this, an
 * orchestrator publish in one bundle would never reach a subscriber set up
 * in another, and the in-process path silently drops every event.
 *
 * Tests construct their own notifier instances and never import these
 * singletons, so test isolation is preserved.
 */
import {
  InProcessArtifactNotifier,
  type IArtifactNotifier,
} from './artifact-notifier';
import {
  InProcessAgentLifecycleNotifier,
  type IAgentLifecycleNotifier,
} from './agent-lifecycle-notifier';
import {
  InProcessDecisionNotifier,
  type IDecisionNotifier,
} from './orchestrator-core';
import { RedisArtifactNotifier } from './redis-artifact-notifier';
import { RedisAgentLifecycleNotifier } from './redis-agent-lifecycle-notifier';
import { RedisDecisionNotifier } from './redis-decision-notifier';
import { getRedisPublisher, getRedisSubscriber } from '../../services/redis';
import { loggerFor } from '../../services/logger';

const log = loggerFor('orchestrator.notifiers');

function buildNotifiers(): {
  decision: IDecisionNotifier;
  artifact: IArtifactNotifier;
  lifecycle: IAgentLifecycleNotifier;
} {
  const publisher = getRedisPublisher();
  const subscriber = getRedisSubscriber();
  if (publisher && subscriber) {
    log.info('orchestrator.notifiers.mode_redis');
    return {
      decision: new RedisDecisionNotifier(publisher, subscriber),
      artifact: new RedisArtifactNotifier(publisher, subscriber),
      lifecycle: new RedisAgentLifecycleNotifier(publisher, subscriber),
    };
  }
  log.warn('orchestrator.notifiers.mode_in_process');
  return {
    decision: new InProcessDecisionNotifier(),
    artifact: new InProcessArtifactNotifier(),
    lifecycle: new InProcessAgentLifecycleNotifier(),
  };
}

type NotifierBundle = ReturnType<typeof buildNotifiers>;

const NOTIFIERS_SLOT = Symbol.for('mypes.orchestrator.notifiers');
type NotifiersHolder = { [NOTIFIERS_SLOT]?: NotifierBundle };
const holder = globalThis as unknown as NotifiersHolder;
const notifiers: NotifierBundle = (holder[NOTIFIERS_SLOT] ??= buildNotifiers());

export const defaultDecisionNotifier: IDecisionNotifier = notifiers.decision;
export const defaultArtifactNotifier: IArtifactNotifier = notifiers.artifact;
export const defaultLifecycleNotifier: IAgentLifecycleNotifier = notifiers.lifecycle;
