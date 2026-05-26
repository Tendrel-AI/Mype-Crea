/**
 * Artifact-published event channel.
 *
 * Parallel to IDecisionNotifier: the decision notifier publishes
 * PlannerDecision values (what the output adapter should say next), the
 * artifact notifier publishes the actual deliverables produced by transports
 * (image URLs, generated text blobs, …). Splitting them keeps the planner
 * pure — artifacts never enter PlannerDecision — and lets the SSE/UI edge
 * subscribe to artifacts without knowing anything about decisions.
 *
 * In-process implementation today; production replaces with a Postgres
 * LISTEN/NOTIFY or Redis pub/sub-backed implementation when the SSE route and
 * the orchestrator dispatch run in different processes.
 */
import { EventEmitter } from 'node:events';
import type { AgentId, ConversationId, TaskId } from '../contracts';
import type { A2AArtifact } from '../agent-types';
import { loggerFor } from '../../services/logger';

const log = loggerFor('orchestrator.notifier.artifact.in_process');

export interface ArtifactPublishedEvent {
  readonly conversationId: ConversationId;
  readonly agentId: AgentId;
  readonly taskId: TaskId;
  readonly artifacts: ReadonlyArray<A2AArtifact>;
}

export interface IArtifactNotifier {
  publish(event: ArtifactPublishedEvent): void;
  subscribe(
    conversationId: ConversationId,
    handler: (event: ArtifactPublishedEvent) => void,
  ): { dispose(): void };
}

/** In-process notifier. Production replaces with a LISTEN/NOTIFY-backed one. */
export class InProcessArtifactNotifier implements IArtifactNotifier {
  private readonly emitter = new EventEmitter();

  publish(event: ArtifactPublishedEvent): void {
    const subscribers = this.emitter.listenerCount(event.conversationId);
    log.info(
      {
        conversationId: event.conversationId,
        agentId: event.agentId,
        taskId: event.taskId,
        artifactCount: event.artifacts.length,
        subscribers,
      },
      subscribers === 0
        ? 'notifier.artifact.publish.no_subscribers'
        : 'notifier.artifact.publish.delivered',
    );
    this.emitter.emit(event.conversationId, event);
  }

  subscribe(
    conversationId: ConversationId,
    handler: (event: ArtifactPublishedEvent) => void,
  ): { dispose(): void } {
    this.emitter.on(conversationId, handler);
    log.info(
      {
        conversationId,
        listeners: this.emitter.listenerCount(conversationId),
      },
      'notifier.artifact.subscribe',
    );
    return {
      dispose: () => {
        this.emitter.off(conversationId, handler);
        log.info(
          {
            conversationId,
            listeners: this.emitter.listenerCount(conversationId),
          },
          'notifier.artifact.unsubscribe',
        );
      },
    };
  }
}
