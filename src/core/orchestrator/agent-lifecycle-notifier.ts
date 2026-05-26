/**
 * Agent task-lifecycle event channel.
 *
 * Sibling of IArtifactNotifier. Where the artifact notifier publishes the
 * deliverables a task produced, the lifecycle notifier publishes the task's
 * phase transitions — today: "processing" (a worker has claimed the row and
 * started running the handler).
 *
 * The decision channel is for the Responder ("what should the chat say?").
 * The artifact channel is for the side panel ("what did the agent produce?").
 * The lifecycle channel is for status feedback ("is the agent still working?").
 * Three channels keep each consumer narrow and let the planner stay pure.
 *
 * In-process implementation today; production replaces with a Redis
 * pub/sub-backed implementation when the SSE route and the workers run in
 * different processes (see redis-agent-lifecycle-notifier.ts).
 */
import { EventEmitter } from 'node:events';
import type { AgentId, ConversationId, TaskId } from '../contracts';

export interface AgentTaskProcessingEvent {
  readonly conversationId: ConversationId;
  readonly agentId: AgentId;
  readonly taskId: TaskId;
  /** ISO-8601 timestamp at which the worker claimed the row. */
  readonly claimedAt: string;
}

export interface IAgentLifecycleNotifier {
  publishProcessing(event: AgentTaskProcessingEvent): void;
  subscribeProcessing(
    conversationId: ConversationId,
    handler: (event: AgentTaskProcessingEvent) => void,
  ): { dispose(): void };
}

const PROCESSING_CHANNEL = 'processing';

export class InProcessAgentLifecycleNotifier implements IAgentLifecycleNotifier {
  private readonly emitter = new EventEmitter();

  publishProcessing(event: AgentTaskProcessingEvent): void {
    this.emitter.emit(`${PROCESSING_CHANNEL}:${event.conversationId}`, event);
  }

  subscribeProcessing(
    conversationId: ConversationId,
    handler: (event: AgentTaskProcessingEvent) => void,
  ): { dispose(): void } {
    const key = `${PROCESSING_CHANNEL}:${conversationId}`;
    this.emitter.on(key, handler);
    return {
      dispose: () => this.emitter.off(key, handler),
    };
  }
}
