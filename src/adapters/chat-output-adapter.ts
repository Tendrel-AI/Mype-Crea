/**
 * MYPES Platform — Chat output adapter (Layer 4: Responder)
 * ==========================================================
 *
 * Location: src/adapters/chat-output-adapter.ts
 *
 * Consumes a `ReadonlyArray<PlannerDecision>` (the orchestrator's plan for
 * this turn) and produces the user-visible Spanish reply by calling Gemini
 * Pro through the LLM provider abstraction. Text-only output: this adapter
 * never emits tool calls. Tool-driven side effects (image generation, HTML,
 * marketing markdown) live in the legacy chat path used by Pasos 2-5.
 *
 * The plan is an array because a single user turn can bundle multiple
 * decisions, e.g. `[announce_dispatch(logo), request_fields(tagline:
 * business_profile)]`. The Responder always speaks; there is no "idle" turn.
 *
 * Contract conformance: this PR uses an imperative `render()` shape because
 * Next.js server actions are request/response. The `OutputAdapter.onDecision`
 * subscription contract from contracts.ts is intentionally NOT implemented
 * here yet — it'll be added when the controller flow becomes pub/sub.
 */

import type {
  ConversationSnapshot,
  FieldSlot,
  PlannerDecision,
} from '../core/contracts';
import type { A2AArtifact } from '../core/agent-types';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';
import type { MessageRow } from '../repos/models';
import { getProvider } from '../services/llm';
import { withLlmLogging, type LlmLoggingContext } from '../services/llm-logger';
import { loggerFor } from '../services/logger';

const log = loggerFor('adapter.chat-output');

const RESPONDER_PROMPT_VERSION = 'responder.chat-step1.v4';

/** How many recent turns to include for tone continuity. */
const RECENT_MESSAGE_LIMIT = 10;

export interface RenderInput {
  readonly decisions: ReadonlyArray<PlannerDecision>;
  readonly recentMessages: ReadonlyArray<Pick<MessageRow, 'role' | 'content'>>;
  readonly snapshot: ConversationSnapshot;
  readonly llmContext: LlmLoggingContext;
}

export class ChatOutputAdapter {
  constructor(private readonly registry: AgentRegistry) {}

  async render(input: RenderInput): Promise<{ content: string }> {
    const { decisions, recentMessages, snapshot, llmContext } = input;
    const child = log.child({
      op: 'render',
      conversationId: snapshot.conversationId,
      tenantId: snapshot.tenantId,
      decisionKinds: decisions.map((d) => d.kind),
    });

    const systemPrompt = buildResponderSystemPrompt(decisions, snapshot, this.registry);
    const recent = recentMessages
      .slice(-RECENT_MESSAGE_LIMIT)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    child.info(
      {
        contract: 'PlannerDecision[]',
        decisions,
        recentMessagesCount: recent.length,
        snapshotAgentsCount: Object.keys(snapshot.agentStates).length,
      },
      'responder.input',
    );

    const resolved = getProvider().resolve('responder');
    child.info({ model: resolved.modelId }, 'responder.llm.start');

    const completion = await withLlmLogging(
      resolved.client,
      {
        model: resolved.modelId,
        messages: [{ role: 'system', content: systemPrompt }, ...recent],
        temperature: 0.7,
        max_tokens: 1800,
      },
      { ...llmContext, promptVersion: RESPONDER_PROMPT_VERSION, modelRevision: resolved.modelRevision },
    );

    const content = completion.choices[0]?.message?.content?.trim() ?? '';
    if (content.length === 0) {
      child.warn('responder.empty_content');
    }
    child.info(
      {
        contractOut: 'AssistantMessage',
        contentLength: content.length,
        contentPreview: content.length > 120 ? `${content.slice(0, 117)}...` : content,
      },
      'responder.output',
    );
    return { content };
  }
}

function buildResponderSystemPrompt(
  decisions: ReadonlyArray<PlannerDecision>,
  snapshot: ConversationSnapshot,
  registry: AgentRegistry,
): string {
  const persona = [
    `Eres "CreaMype", una estratega de marca peruana que conversa en español rioplatense neutro,`,
    `cálido y profesional. Hablas con micro y pequeñas empresarias peruanas (MYPEs) que están`,
    `creando su marca paso a paso.`,
  ].join(' ');

  const statusSummary = describeFieldStatus(snapshot);
  const decisionsBlock = describeDecisions(decisions, registry);
  const guardrails = buildGuardrails(decisions);

  return [
    persona,
    ``,
    `Estado actual del orquestador (autoritativo, no lo cuestiones):`,
    decisionsBlock,
    statusSummary ? `\nProgreso de campos (solo estados, sin valores):\n${statusSummary}` : '',
    ``,
    guardrails,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function describeDecisions(
  decisions: ReadonlyArray<PlannerDecision>,
  registry: AgentRegistry,
): string {
  if (decisions.length === 0) {
    // Should not happen — the planner always returns at least one decision —
    // but degrade gracefully rather than send an empty prompt.
    return [
      `kind=noop`,
      `Decisión: no hay nada nuevo que comunicar.`,
      `Acción obligatoria: en UNA sola frase corta, invita al usuario con una pregunta abierta a contarte sobre su negocio.`,
    ].join('\n');
  }

  if (decisions.length === 1) {
    return describeDecision(decisions[0], registry);
  }

  return decisions
    .map((d, i) => `Decisión ${i + 1}:\n${describeDecision(d, registry)}`)
    .join('\n\n');
}

function describeDecision(decision: PlannerDecision, registry: AgentRegistry): string {
  // Each block leads with `kind=...` as a machine-readable tag so the
  // responder can ground on the literal decision name from PlannerDecision,
  // and so log audits / tests can match on the kind verbatim.
  const kindTag = `kind=${decision.kind}`;
  switch (decision.kind) {
    case 'request_fields': {
      const lines = decision.fields.map(
        (f, i) =>
          `  ${i + 1}. ${f.fieldName}${f.previousValue !== undefined ? ' (el usuario lo había dado y lo reseteó)' : ''}: "${f.promptHint}"`,
      );
      const single = decision.fields.length === 1;
      void registry;
      return [
        kindTag,
        `Decisión: pedir ${single ? 'UN campo' : `${decision.fields.length} campos`} faltantes al usuario.`,
        `Agente: ${decision.agentId}`,
        `Campos a preguntar:`,
        ...lines,
        single
          ? `Acción obligatoria: pídele al usuario ÚNICAMENTE este campo. UNA sola pregunta natural en español.`
          : `Acción obligatoria: pídele al usuario AMBOS campos en UNA sola oración natural en español (por ejemplo "¿cómo se llama tu negocio y qué estilo querés para el logo?"). NO los enumeres como una lista.`,
        `PROHIBIDO mencionar otros agentes o saltar al siguiente paso.`,
      ].join('\n');
    }
    case 'confirm_field':
      return [
        kindTag,
        `Decisión: confirmar un valor de baja confianza con el usuario.`,
        `Agente: ${decision.agentId}`,
        `Campo: ${decision.fieldName}`,
        `Valor pendiente: "${String(decision.pendingValue)}"`,
        `Razón: ${decision.reason}`,
        `Acción obligatoria: parafrasea el valor pendiente y haz UNA sola pregunta cerrada (sí/no) tipo "¿Es correcto?" o "¿Confirmas?".`,
      ].join('\n');
    case 'request_selection':
      return [
        kindTag,
        `Decisión: pedir al usuario que elija una alternativa.`,
        `Agente: ${decision.agentId}`,
        `Cantidad de candidatos: ${decision.candidateDeliverableIds.length}`,
        `Acción obligatoria: invita al usuario a elegir una opción del panel lateral. NO listes los IDs ni inventes nombres.`,
      ].join('\n');
    case 'announce_dispatch':
      return [
        kindTag,
        `Decisión: confirmar que el agente "${decision.agentId}" empezó su trabajo.`,
        `Acción obligatoria: confirma en UNA cláusula breve que el agente empezó (por ejemplo "ya estoy generando tu logo,"). PROHIBIDO usar "estoy trabajando", "estamos trabajando", "dame un momento", "dame un momentito", "ya casi", "un segundo", "en breve", "enseguida". PROHIBIDO usar saludos.`,
      ].join('\n');
    case 'announce_completion':
      return describeAnnounceCompletion(kindTag, decision.agentId, decision.artifacts);
    case 'announce_all_complete':
      return [
        kindTag,
        `Decisión: el flujo de este paso está completo.`,
        `Acción obligatoria: en UNA sola frase, indica que terminó este paso e invita al siguiente. NO recapitules valores.`,
      ].join('\n');
  }
}

/**
 * Tone guardrails. The base set is constant; we add an extra line when the
 * plan bundles `announce_dispatch` with a follow-on `request_fields` so the
 * Responder writes a single bridged sentence ("ya empezó X — para Y, …")
 * instead of two separate replies.
 */
function buildGuardrails(decisions: ReadonlyArray<PlannerDecision>): string {
  const base = [
    `Reglas para tu respuesta (estrictas, sin excepciones):`,
    `- Responde SIEMPRE en español, en máximo 2 oraciones.`,
    `- Tu respuesta DEBE corresponder exactamente a las decisiones indicadas arriba, en el orden listado. NO improvises temas adicionales.`,
    `- NO uses saludos. NUNCA escribas "Hola", "¡Hola!", "Buenas", "Qué tal", "Hey", ni similares. La conversación ya empezó.`,
    `- NO uses muletillas de espera. NUNCA escribas "estoy trabajando", "estamos trabajando", "dame un momentito", "dame un momento", "ya casi", "un segundo", "en breve", "enseguida".`,
    `- NO emitas llamadas a funciones, JSON, ni código.`,
    `- NO inventes información que no esté en el bloque "Decisión" o el "Progreso de campos".`,
    `- NO menciones nombres, productos, ni valores específicos del usuario salvo que la decisión actual los incluya explícitamente (por ejemplo "Valor pendiente" en confirm_field, u "Opciones a presentar" en announce_completion).`,
    `- Mantén un tono cálido pero directo.`,
  ];

  const hasDispatch = decisions.some((d) => d.kind === 'announce_dispatch');
  const hasRequestFields = decisions.some((d) => d.kind === 'request_fields');
  if (hasDispatch && hasRequestFields) {
    base.push(
      `- Cuando combines un anuncio de despacho con una pregunta, escribe UNA sola respuesta de hasta 2 oraciones que primero confirme el despacho en una cláusula breve y luego pivotee a la pregunta del siguiente agente. Ejemplo de pivote: "Ya estoy generando tu logo. Para el slogan, ¿cómo describirías el tono que buscás?".`,
    );
  }
  return base.join('\n');
}

/**
 * Build the announce_completion block. Branches on artifact kind:
 *  - text artifacts (`kind === 'text'` with string `inline`): list them
 *    literally so the Responder can present them in the chat reply. This is
 *    the channel through which name/tagline/label suggestions reach the user.
 *  - image/visual artifacts: keep the existing "look at the side panel"
 *    template — the SSE stream already pushed the URL to the UI.
 *  - mixed: image template wins, with a hint to confirm.
 */
function describeAnnounceCompletion(
  kindTag: string,
  agentId: string,
  artifacts: ReadonlyArray<A2AArtifact>,
): string {
  const textOptions = artifacts
    .filter((a) => a.kind === 'text' && typeof a.inline === 'string')
    .map((a) => String(a.inline));
  const hasVisual = artifacts.some((a) => a.kind !== 'text');

  if (textOptions.length > 0 && !hasVisual) {
    const numbered = textOptions
      .map((text, i) => `  ${i + 1}. ${text}`)
      .join('\n');
    return [
      kindTag,
      `Decisión: presentar las opciones que produjo el agente "${agentId}".`,
      `Opciones a presentar (literal, en este orden):`,
      numbered,
      `Acción obligatoria: lista estas opciones EXACTAMENTE como aparecen, numeradas de 1 a ${textOptions.length}, y pídele al usuario que elija una. PROHIBIDO inventar opciones adicionales, modificar el texto, o agregar comentarios sobre cada opción.`,
    ].join('\n');
  }

  if (hasVisual) {
    return [
      kindTag,
      `Decisión: anunciar que el agente "${agentId}" terminó. El resultado ya está en el panel lateral.`,
      `Acción obligatoria: en UNA sola frase, confirma que el resultado está en el panel lateral e invita al siguiente paso. PROHIBIDO describir el contenido visual.`,
    ].join('\n');
  }

  // No artifacts at all — degrade to a minimal completion message.
  return [
    kindTag,
    `Decisión: anunciar que el agente "${agentId}" terminó.`,
    `Acción obligatoria: en UNA sola frase, indica que terminó este paso e invita al siguiente.`,
  ].join('\n');
}

/**
 * Status-only summary: filled / pending / empty per field, never the value.
 * Values reach the responder only through the decision block (confirm_field's
 * `pendingValue`), which is the one place value paraphrase is expected.
 */
function describeFieldStatus(snapshot: ConversationSnapshot): string {
  const lines: string[] = [];
  for (const [agentId, agentState] of Object.entries(snapshot.agentStates)) {
    for (const [fieldName, slot] of Object.entries(agentState.requiredFields) as Array<
      [string, FieldSlot]
    >) {
      lines.push(`- ${agentId}.${fieldName} (requerido): ${slot.status}`);
    }
    for (const [fieldName, slot] of Object.entries(agentState.optionalFields) as Array<
      [string, FieldSlot]
    >) {
      lines.push(`- ${agentId}.${fieldName} (opcional): ${slot.status}`);
    }
  }
  return lines.join('\n');
}
