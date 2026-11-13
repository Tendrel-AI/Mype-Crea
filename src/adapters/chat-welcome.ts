/**
 * KAN-93 — Opening message of a conversation (chat output side, no LLM).
 *
 * Pure and deterministic: fixed Spanish templates over the planner's decision, so the opening text
 * always matches the conversation's real state (brand or product chat, pending fields, deliverable
 * status). Wording mirrors the Responder fragments in `services/ai-config/adapter-behavior.ts`.
 */
import type { PlannerDecision } from '../core/contracts';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';
import { UNNAMED_BRAND_LABEL, UNNAMED_PRODUCT_LABEL } from '../conversations/label';
import { COMMAND_BUTTON_LABELS, deliverableLabelFor } from './chat-output-adapter';

/** Brand/product of a conversation (structurally `ConversationContext`); null brand = legacy conversation. */
export interface ChatContext {
  readonly brandId: string | null;
  readonly brandName: string | null;
  readonly productId: string | null;
  readonly productName: string | null;
}

export const WELCOME_FALLBACK_TEXT = 'Cuéntame en qué quieres trabajar hoy.';

export function welcomeContextLine(context: ChatContext | null | undefined): string {
  if (!context?.brandId) return '';
  const brand = context.brandName?.trim() || UNNAMED_BRAND_LABEL;
  if (!context.productId) return `Este es el chat de tu marca «${brand}».`;
  const product = context.productName?.trim() || UNNAMED_PRODUCT_LABEL;
  return `Este es el chat de tu producto «${product}» de la marca «${brand}». Aquí creamos su etiqueta nutricional y su foto publicitaria.`;
}

function describe(decision: PlannerDecision, context: ChatContext | null | undefined, registry: AgentRegistry): string {
  switch (decision.kind) {
    case 'request_fields': {
      const uploadHints = (decision.uploads ?? []).map((u) => `- ${u.promptHint}`);
      // D47: the brand chat asks at most 6 essentials; one natural question per line.
      if (decision.fields.length <= 6) {
        const intro = decision.fields.length <= 2 ? 'Para avanzar necesito esto:' : 'Para avanzar, cuéntame en un solo mensaje:';
        return [intro, ...uploadHints, ...decision.fields.map((f) => `- ${f.promptHint}`)].join('\n');
      }
      // D29: more than 6 fields: no per-field list; one open invitation. The Extractor maps the answer.
      return [...uploadHints, 'Para avanzar, cuéntame en un solo mensaje lo que tengas claro: qué quieres lograr, qué te inspira, el estilo que imaginas y lo que no quieres ver o no puedes usar.'].join('\n');
    }
    case 'request_upload':
      return decision.promptHint;
    case 'confirm_fields':
      return decision.entries.length === 1
        ? `Tengo este valor pendiente: «${String(decision.entries[0].pendingValue)}». ¿Es correcto?`
        : `Tengo estos valores pendientes:\n${decision.entries.map((e) => `- «${String(e.pendingValue)}»`).join('\n')}\n¿Es todo correcto?`;
    case 'offer_generation':
      return `Ya tienes todo listo para tu ${inSentence(deliverableLabelFor(decision.agentId, decision.deliverableKind, registry))}. Cuando quieras, toca el botón Generar.`;
    case 'report_deliverable_status': {
      const label = inSentence(deliverableLabelFor(decision.agentId, decision.deliverableKind, registry));
      const can = (c: (typeof decision.allowedCommands)[number]) => decision.allowedCommands.includes(c);
      if (decision.state === 'generating') return `Tu ${label} se está generando y aparecerá en el panel.`;
      if (decision.state === 'failed') {
        return `Algo salió mal al generar tu ${label}.${can('retry') ? ` Puedes volver a intentarlo con el botón ${COMMAND_BUTTON_LABELS.retry}.` : ''}`;
      }
      const actions = [
        can('approve') ? `si te gusta, toca ${COMMAND_BUTTON_LABELS.approve}` : '',
        can('iterate') ? `si quieres cambios, toca ${COMMAND_BUTTON_LABELS.iterate}` : '',
      ].filter(Boolean).join('; ');
      return `Tu ${label} está en el panel para que lo revises${actions ? `: ${actions}` : ''}.`;
    }
    case 'announce_all_complete':
      return context?.productId
        ? 'Tu etiqueta nutricional está lista. Puedes revisarla en el panel o subir otro análisis para actualizarla.'
        : 'Tu marca está lista. Para continuar, crea un producto con el botón «Nuevo producto».';
    case 'request_selection':
      return 'Elige una de las opciones en el panel lateral.';
    default:
      return '';
  }
}

/** Context line + the text of the first planner decision (announcements are ignored). */
export function renderWelcome(
  decisions: ReadonlyArray<PlannerDecision>,
  context: ChatContext | null | undefined,
  registry: AgentRegistry,
): string {
  const planned = decisions.find((d) => d.kind !== 'announce_dispatch' && d.kind !== 'announce_completion');
  const body = (planned ? describe(planned, context, registry) : '') || WELCOME_FALLBACK_TEXT;
  return [welcomeContextLine(context), body].filter(Boolean).join('\n\n');
}

/** Tab labels are capitalized («Logo»); mid-sentence they read «tu logo». */
function inSentence(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
