/**
 * Which logo URL a live `task_completed` notice puts in the panel (KAN-81).
 * Live and reconciled notices carry the same artifact kind, so both reach here.
 */
import type { NotificationPayload } from '../../src/core/contracts/notifications';

export const LOGO_AGENT_ID = 'logo-agent';

export function completedLogoUrl(event: NotificationPayload<'task_completed'>): string | null {
  if (event.agentId !== LOGO_AGENT_ID) return null;
  return event.artifacts.find((artifact) => artifact.kind === 'image')?.url ?? null;
}
