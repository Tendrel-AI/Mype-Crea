import { randomUUID } from 'node:crypto';
import type { ConversationId, DeliverableId, TaskId } from './contracts';

export function newConversationId(): ConversationId {
  return randomUUID();
}

export function newTaskId(): TaskId {
  return randomUUID();
}

export function newDeliverableId(): DeliverableId {
  return randomUUID();
}
