/**
 * Client-facing copy for failed tasks (KAN-58). Neutral Latin-American
 * Spanish, tú, never voseo.
 *
 * - `failedCardMessage`: what the deliverable card always shows in the
 *   `failed` state. Plain language, no technical detail; it points to the
 *   recovery commands the server offers.
 * - `developerFailureChatText`: the chat message for a failed task, built
 *   only when the server sent `task_failed.detail` — which the SSE edge does
 *   only when the failure-disclosure policy allows it (developer mode).
 */
import type { DeliverableStateView, TaskFailureDetail } from '../../src/core/contracts';
import { usageLimitMessage } from '../../src/services/usage/policy';

/** Card copy for a failed deliverable. `label` is a lowercase noun, e.g. "logo". */
export function failedCardMessage(
  view: Pick<DeliverableStateView, 'lastFailure' | 'allowedCommands'> & Partial<Pick<DeliverableStateView, 'deliverableKind'>>,
  label: string,
): string {
  // KAN-43: a usage gate failed the task (a race past the preflight). Names are an LLM call (KAN-31),
  // every other live deliverable an image.
  // shortcut: the task error does not carry the denial reason, so a rare tenant-budget denial here
  // also shows the per-user copy; the next command's preflight shows the exact reason.
  if (view.lastFailure?.errorKind === 'usage_limited') {
    return usageLimitMessage(view.deliverableKind === 'business_name' ? 'user_llm_hourly' : 'user_image_daily');
  }
  const base = `No pudimos generar tu ${label}.`;
  if (view.allowedCommands.length === 0) {
    // Recovery commands also need a complete brief and approved upstream deliverables.
    return `${base} Completa la información en el chat para volver a intentarlo.`;
  }
  switch (view.lastFailure?.errorCategory) {
    case 'transient':
      return `${base} Fue un problema temporal: toca Reintentar.`;
    case 'content_policy':
      return `${base} Toca Iterar para cambiar lo que pediste, o Reintentar para probar otra vez.`;
    default:
      return `${base} Toca Reintentar para probar otra vez.`;
  }
}

/** Developer-only chat text for a failed task (only built when the server sent the detail). */
export function developerFailureChatText(agentId: string, detail: TaskFailureDetail): string {
  return `[Modo desarrollo] Falló la tarea de ${agentId}. Categoría: ${detail.errorCategory}. Tipo: ${detail.errorKind}. Detalle: ${detail.message}`;
}
