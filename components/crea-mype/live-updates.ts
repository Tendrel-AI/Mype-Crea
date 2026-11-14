/**
 * Live-update rules of the wizard (KAN-30), kept pure so they are testable
 * without a browser: which agents show a processing indicator, and when the
 * SSE stream counts as lost. Nothing here polls or reloads on its own.
 */

import type { ClientNotification } from '../../src/core/contracts/notifications';

/** Shown when the live stream is gone; the reload re-reads durable state and dispatches nothing. */
export const LIVE_CONNECTION_LOST_MESSAGE = 'Se perdió la conexión en vivo. Recarga para ver el estado actual.';

/** `EventSource.CLOSED`; the constant is not defined outside the browser. */
const EVENT_SOURCE_CLOSED = 2;

/**
 * On an EventSource `error`: lost when the browser gave up (CLOSED, e.g. an
 * HTTP error or a closed stream) or a reconnection attempt failed again
 * before any `open`. A single drop the browser is retrying is not reported.
 */
export function liveConnectionLost(readyState: number, errorsSinceOpen: number): boolean {
  return readyState === EVENT_SOURCE_CLOSED || errorsSinceOpen > 1;
}

/**
 * Processing indicators after a live notification: `task_processing` turns
 * one on; a completion or a terminal failure turns it off (the deliverables
 * already shown stay). Returns `prev` when nothing changes.
 */
export function nextProcessingAgents(prev: Set<string>, event: ClientNotification): Set<string> {
  if (event.kind === 'task_processing') return prev.has(event.agentId) ? prev : new Set(prev).add(event.agentId);
  if (!prev.has(event.agentId)) return prev;
  const next = new Set(prev);
  next.delete(event.agentId);
  return next;
}
