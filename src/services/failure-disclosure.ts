/**
 * Failure-disclosure policy (owner decision 2026-10-25, KAN-58).
 *
 * The chat announcement of a failed task with its technical detail (error
 * category, kind, sanitized message) is developer-only. This function is THE
 * gate: the SSE edge (`app/api/agents/stream/route.ts`) passes its result to
 * `toClientNotification`, which strips `task_failed.detail` when it is false.
 * To change who sees failure detail, change this one line.
 *
 * The deliverable card is not affected: it always shows the failed state in
 * plain Spanish with a recovery command, from the deliverable state view.
 *
 * Server-side only (reads the environment through `isDevelopmentMode`).
 */
import { isDevelopmentMode } from './development-mode';

export function exposesTaskFailureDetail(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return isDevelopmentMode(env);
}
