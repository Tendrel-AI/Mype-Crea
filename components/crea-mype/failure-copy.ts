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
import { isTaskErrorKind, type TaskErrorKind } from '../../src/core/task-errors';
import { usageLimitMessage } from '../../src/services/usage/policy';

/**
 * The cause, in plain words, per error kind. Never exposes provider internals or stack traces.
 * `usage_limited` is handled before this table (its copy names the exact limit).
 */
export const FAILURE_CAUSE_BY_KIND: Readonly<Record<TaskErrorKind, string>> = {
  provider_unavailable: 'Lo sentimos, el servicio del proveedor no está disponible en este momento. Inténtalo más tarde.',
  rate_limited: 'El proveedor está recibiendo demasiadas solicitudes. Espera un momento antes de intentarlo de nuevo.',
  timeout: 'La generación dejó de responder. Puedes intentarlo de nuevo.',
  storage_unavailable: 'Se generó el resultado, pero no pudimos guardarlo. Puedes intentarlo de nuevo.',
  content_policy: 'El proveedor rechazó la solicitud por sus políticas de seguridad.',
  provider_rejected: 'El proveedor rechazó la solicitud.',
  invalid_output: 'El proveedor no devolvió un resultado utilizable.',
  config_missing: 'Este servicio no está configurado todavía.',
  not_implemented: 'Este entregable aún no está disponible.',
  handler_threw: 'Ocurrió un error inesperado.',
  usage_limited: 'Alcanzaste un límite de uso. Inténtalo más tarde.',
  account_inactive: 'Tu cuenta está desactivada. Contacta al administrador de tu organización.',
  lab_report_unusable: 'No pudimos usar el análisis de laboratorio.',
  lab_report_missing: 'No encontramos tus análisis guardados. Súbelos de nuevo.',
};

/** Card copy for a failed deliverable. `label` is a lowercase noun, e.g. "logo". */
export function failedCardMessage(
  view: Pick<DeliverableStateView, 'lastFailure' | 'allowedCommands'> & Partial<Pick<DeliverableStateView, 'deliverableKind'>>,
  label: string,
): string {
  // KAN-43: a usage gate failed the task (a race past the preflight). Names and taglines are an LLM
  // call (KAN-31, KAN-32), every other live deliverable an image.
  // shortcut: the task error does not carry the denial reason, so a rare tenant-budget denial here
  // also shows the per-user copy; the next command's preflight shows the exact reason.
  if (view.lastFailure?.errorKind === 'usage_limited') {
    const llm = view.deliverableKind === 'business_name' || view.deliverableKind === 'tagline';
    return usageLimitMessage(llm ? 'user_llm_hourly' : 'user_image_daily');
  }
  // D32: the failure's own message tells the user what to fix (e.g. the lab report could not be read).
  if (view.lastFailure?.errorMessage) return view.lastFailure.errorMessage;
  const base = `No pudimos generar tu ${label}.`;
  const kind = view.lastFailure?.errorKind;
  const cause = isTaskErrorKind(kind) ? ` ${FAILURE_CAUSE_BY_KIND[kind]}` : '';
  if (view.allowedCommands.length === 0) {
    // Recovery commands also need a complete brief and approved upstream deliverables.
    return `${base}${cause} Completa la información en el chat para volver a intentarlo.`;
  }
  switch (view.lastFailure?.errorCategory) {
    case 'transient':
      return cause ? `${base}${cause} Toca Reintentar.` : `${base} Fue un problema temporal: toca Reintentar.`;
    case 'content_policy':
      return `${base}${cause} Toca Iterar para cambiar lo que pediste, o Reintentar para probar otra vez.`;
    default:
      return `${base}${cause} Toca Reintentar para probar otra vez.`;
  }
}

/** Developer-only chat text for a failed task (only built when the server sent the detail). */
export function developerFailureChatText(agentId: string, detail: TaskFailureDetail): string {
  return `[Modo desarrollo] Falló la tarea de ${agentId}. Categoría: ${detail.errorCategory}. Tipo: ${detail.errorKind}. Detalle: ${detail.message}`;
}
