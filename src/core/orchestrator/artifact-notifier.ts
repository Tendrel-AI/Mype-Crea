/**
 * Artifact-published event channel.
 *
 * Parallel to IDecisionNotifier: the decision notifier publishes
 * PlannerDecision values (what the output adapter should say next), the
 * artifact notifier publishes the actual deliverables produced by transports
 * (image URLs, generated text blobs, …). Splitting them keeps the planner
 * pure — artifacts never enter PlannerDecision.
 *
 * The payload is the `artifact_published` kind of the notification contract
 * (`src/core/contracts/notifications.ts`); both implementations go through
 * the generic channels in `./notification-channels.ts`.
 */
import type { ConversationId } from '../contracts';
import type { NotificationPayload } from '../contracts/notifications';
import { InProcessNotificationChannel, type NotificationChannel } from './notification-channels';

export type ArtifactPublishedEvent = NotificationPayload<'artifact_published'>;

export interface IArtifactNotifier {
  publish(event: ArtifactPublishedEvent): void;
  subscribe(
    conversationId: ConversationId,
    handler: (event: ArtifactPublishedEvent) => void,
  ): { dispose(): void };
}

/** Artifact notifier over any `artifact_published` channel. */
export class ChannelArtifactNotifier implements IArtifactNotifier {
  constructor(private readonly channel: NotificationChannel<'artifact_published'>) {}

  publish(event: ArtifactPublishedEvent): void {
    this.channel.publish(event);
  }

  subscribe(conversationId: ConversationId, handler: (event: ArtifactPublishedEvent) => void): { dispose(): void } {
    return this.channel.subscribe(conversationId, handler);
  }
}

/** In-process notifier (single-process dev/tests). */
export class InProcessArtifactNotifier extends ChannelArtifactNotifier {
  constructor() {
    super(new InProcessNotificationChannel('artifact_published'));
  }
}
