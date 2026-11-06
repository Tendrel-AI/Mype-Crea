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
 * The payload is the `task_processing` kind of the notification contract
 * (`src/core/contracts/notifications.ts`).
 */
import type { ConversationId } from '../contracts';
import type { NotificationPayload } from '../contracts/notifications';
import { InProcessNotificationChannel, type NotificationChannel } from './notification-channels';

export type AgentTaskProcessingEvent = NotificationPayload<'task_processing'>;

export interface IAgentLifecycleNotifier {
  publishProcessing(event: AgentTaskProcessingEvent): void;
  subscribeProcessing(
    conversationId: ConversationId,
    handler: (event: AgentTaskProcessingEvent) => void,
  ): { dispose(): void };
}

/** Lifecycle notifier over any `task_processing` channel. */
export class ChannelAgentLifecycleNotifier implements IAgentLifecycleNotifier {
  constructor(private readonly channel: NotificationChannel<'task_processing'>) {}

  publishProcessing(event: AgentTaskProcessingEvent): void {
    this.channel.publish(event);
  }

  subscribeProcessing(
    conversationId: ConversationId,
    handler: (event: AgentTaskProcessingEvent) => void,
  ): { dispose(): void } {
    return this.channel.subscribe(conversationId, handler);
  }
}

/** In-process notifier (single-process dev/tests). */
export class InProcessAgentLifecycleNotifier extends ChannelAgentLifecycleNotifier {
  constructor() {
    super(new InProcessNotificationChannel('task_processing'));
  }
}
