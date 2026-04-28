/**
 * MYPES Platform — Chat output adapter (Layer 4: Responder)
 * ==========================================================
 *
 * Location: src/adapters/chat-output-adapter.ts
 *
 * Consumes a `PlannerDecision` and produces the user-visible Spanish reply
 * by calling Gemini Pro through the LLM provider abstraction. Text-only
 * output: this adapter never emits tool calls. Tool-driven side effects
 * (image generation, HTML, marketing markdown) live in the legacy chat
 * path used by Pasos 2-5.
 *
 * Contract conformance: this PR uses an imperative `render()` shape
 * because Next.js server actions are request/response. The
 * `OutputAdapter.onDecision` subscription contract from contracts.ts is
 * intentionally NOT implemented here yet — it'll be added when the
 * controller flow becomes pub/sub (Postgres LISTEN/NOTIFY or a streaming
 * channel). The render() method is the entire surface the controller
 * needs today.
 */

import type {
  AgentId,
  ConversationSnapshot,
  FieldSlot,
  PlannerDecision,
} from '../core/contracts';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';
import type { MessageRow } from '../repos/models';
import { getProvider } from '../services/llm';
import { withLlmLogging, type LlmLoggingContext } from '../services/llm-logger';
import { loggerFor } from '../services/logger';

const log = loggerFor('adapter.chat-output');

const RESPONDER_PROMPT_VERSION = 'responder.chat-step1.v1';

/** How many recent turns to include for tone continuity. */
const RECENT_MESSAGE_LIMIT = 10;

export interface RenderInput {
  readonly decision: PlannerDecision;
  readonly recentMessages: ReadonlyArray<Pick<MessageRow, 'role' | 'content'>>;
  readonly snapshot: ConversationSnapshot;
  readonly llmContext: LlmLoggingContext;
}

export class ChatOutputAdapter {
  constructor(private readonly registry: AgentRegistry) {}

  async render(input: RenderInput): Promise<{ content: string }> {
    const { decision, recentMessages, snapshot, llmContext } = input;
    const child = log.child({
      op: 'render',
      conversationId: snapshot.conversationId,
      tenantId: snapshot.tenantId,
      decisionKind: decision.kind,
    });

    const systemPrompt = buildResponderSystemPrompt(decision, snapshot, this.registry);
    const recent = recentMessages
      .slice(-RECENT_MESSAGE_LIMIT)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const resolved = getProvider().resolve('responder');
    child.info({ model: resolved.modelId }, 'responder.llm.start');

    const completion = await withLlmLogging(
      resolved.client,
      {
        model: resolved.modelId,
        messages: [{ role: 'system', content: systemPrompt }, ...recent],
        temperature: 0.7,
        max_tokens: 600,
      },
      { ...llmContext, promptVersion: RESPONDER_PROMPT_VERSION, modelRevision: resolved.modelRevision },
    );

    const content = completion.choices[0]?.message?.content?.trim() ?? '';
    if (content.length === 0) {
      child.warn('responder.empty_content');
    }
    return { content };
  }
}

function buildResponderSystemPrompt(
  decision: PlannerDecision,
  snapshot: ConversationSnapshot,
  registry: AgentRegistry,
): string {
  const persona = [
    `Eres "CreaMype", una estratega de marca peruana que conversa en español rioplatense neutro,`,
    `cálido y profesional. Hablas con micro y pequeñas empresarias peruanas (MYPEs) que están`,
    `creando su marca paso a paso.`,
  ].join(' ');

  const filledSummary = describeFilledFields(decision.kind, snapshot);
  const decisionBlock = describeDecision(decision, registry);

  const guardrails = [
    `Reglas para tu respuesta:`,
    `- Responde SIEMPRE en español, en máximo 3 oraciones.`,
    `- NO emitas llamadas a funciones, JSON, ni código.`,
    `- NO inventes información que no esté en el estado de conversación.`,
    `- Mantén un tono motivador, sin ser empalagoso.`,
  ].join('\n');

  return [
    persona,
    ``,
    `Estado actual del orquestador (autoritativo, no lo cuestiones):`,
    decisionBlock,
    filledSummary ? `\nCampos ya capturados:\n${filledSummary}` : '',
    ``,
    guardrails,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function describeDecision(decision: PlannerDecision, registry: AgentRegistry): string {
  // Each block leads with `kind=...` as a machine-readable tag so the
  // responder can ground on the literal decision name from PlannerDecision,
  // and so log audits / tests can match on the kind verbatim.
  const kindTag = `kind=${decision.kind}${decision.kind === 'idle' ? `:${decision.reason}` : ''}`;
  switch (decision.kind) {
    case 'request_field':
      return [
        kindTag,
        `Decisión: pedir un campo faltante.`,
        `Agente: ${decision.agentId}`,
        `Campo: ${decision.fieldName}`,
        `Pista del agente: "${decision.promptHint}"`,
        `Tu trabajo: pídele al usuario este campo de forma natural y conversacional.`,
        decision.previousValue !== undefined
          ? `(El usuario ya lo había proporcionado antes con valor "${String(decision.previousValue)}" pero lo reseteó.)`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    case 'confirm_field':
      return [
        kindTag,
        `Decisión: confirmar un valor de baja confianza con el usuario.`,
        `Agente: ${decision.agentId}`,
        `Campo: ${decision.fieldName}`,
        `Valor pendiente: "${String(decision.pendingValue)}"`,
        `Razón: ${decision.reason}`,
        `Tu trabajo: parafrasea el valor y pregunta "¿Es correcto?" / "¿Confirmas?".`,
      ].join('\n');
    case 'request_selection':
      return [
        kindTag,
        `Decisión: pedir al usuario que elija una alternativa.`,
        `Agente: ${decision.agentId}`,
        `Cantidad de candidatos: ${decision.candidateDeliverableIds.length}`,
        `Tu trabajo: invita al usuario a elegir una opción del panel lateral.`,
      ].join('\n');
    case 'announce_dispatch':
      return [
        kindTag,
        `Decisión: avisar que el agente está trabajando.`,
        `Agente: ${decision.agentId}`,
        `Tu trabajo: dile al usuario en una frase breve que estás guardando/procesando su información.`,
      ].join('\n');
    case 'announce_completion': {
      const labelHint = safePromptHint(registry, decision.agentId, 'business_name');
      return [
        kindTag,
        `Decisión: anunciar que el agente terminó y entregó un resultado.`,
        `Agente: ${decision.agentId}`,
        `Tu trabajo: felicita al usuario, resume el resultado capturado (revisa los campos en el bloque de "Campos ya capturados") y propón pasar al siguiente paso del wizard.`,
        labelHint ? `Pista de campo principal: "${labelHint}"` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'idle':
      switch (decision.reason) {
        case 'all_complete':
          return [
            kindTag,
            `Decisión: el flujo de este paso está completo.`,
            `Tu trabajo: dile al usuario que terminamos este paso e invítalo a continuar con el siguiente.`,
          ].join('\n');
        case 'awaiting_dispatch':
          return [
            kindTag,
            `Decisión: hay un agente despachado que aún no responde.`,
            `Tu trabajo: avisa brevemente que estás trabajando, sin pedir más datos.`,
          ].join('\n');
        case 'awaiting_user':
        default:
          return [
            kindTag,
            `Decisión: esperando al usuario.`,
            `Tu trabajo: invítalo a contarte más sobre su negocio para avanzar.`,
          ].join('\n');
      }
  }
}

function describeFilledFields(
  decisionKind: PlannerDecision['kind'],
  snapshot: ConversationSnapshot,
): string {
  const lines: string[] = [];
  for (const [agentId, agentState] of Object.entries(snapshot.agentStates)) {
    for (const [fieldName, slot] of Object.entries(agentState.requiredFields) as Array<
      [string, FieldSlot]
    >) {
      if (slot.status === 'filled') {
        lines.push(`- ${agentId}.${fieldName}: ${JSON.stringify(slot.value)}`);
      } else if (slot.status === 'pending_confirmation' && decisionKind !== 'confirm_field') {
        lines.push(`- ${agentId}.${fieldName} (pendiente de confirmar): ${JSON.stringify(slot.value)}`);
      }
    }
    for (const [fieldName, slot] of Object.entries(agentState.optionalFields) as Array<
      [string, FieldSlot]
    >) {
      if (slot.status === 'filled') {
        lines.push(`- ${agentId}.${fieldName} (opcional): ${JSON.stringify(slot.value)}`);
      }
    }
  }
  return lines.join('\n');
}

function safePromptHint(registry: AgentRegistry, agentId: AgentId, fieldName: string): string | undefined {
  try {
    return registry.getPromptHint(agentId, fieldName);
  } catch {
    return undefined;
  }
}
