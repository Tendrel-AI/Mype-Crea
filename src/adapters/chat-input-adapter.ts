/**
 * MYPES Platform — Chat input adapter (Layer 1: Extractor)
 * =========================================================
 *
 * Location: src/adapters/chat-input-adapter.ts
 *
 * Converts a user's Spanish chat turn into a `FieldDelta` against the active
 * agent's schema. Two paths:
 *
 *   1. Affirmation fast-path: when the prior planner decision was
 *      `confirm_field`, a regex on "sí/ok/confirmo/..." emits a
 *      confidence-1.0 delta reusing the pendingValue. No LLM call.
 *
 *   2. LLM extraction: otherwise, calls Gemini Flash via the LLM provider
 *      with a JSON-output prompt scoped to the active agent's required +
 *      optional fields. Confidence-scored values get filtered against
 *      `CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM` before being returned.
 *
 * Contract conformance: implements `InputAdapter` (id + submit). Controllers
 * call `extract()` directly to obtain a delta, then either feed it through
 * `submit()` or hand it to `OrchestratorCore.applyDelta()` themselves.
 *
 * The orchestrator core does NOT import this file — modality stays at the
 * boundary (architecture skill rule 1).
 */

import {
  CONFIDENCE_THRESHOLDS,
  type AgentId,
  type ConversationId,
  type FieldDelta,
  type InputAdapter,
  type OrchestratorCore,
  type PlannerDecision,
  type AdapterSubmitResult,
  type FieldValueWithConfidence,
} from '../core/contracts';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';
import { getProvider } from '../services/llm';
import { withLlmLogging, type LlmLoggingContext } from '../services/llm-logger';
import { loggerFor } from '../services/logger';

const log = loggerFor('adapter.chat-input');

// Note: `\b` would not work between `í` and `,` because JS regex treats
// non-ASCII letters as non-word characters by default. We anchor on `^\s*`
// + the keyword + a non-letter terminator instead.
const AFFIRMATION_RE = /^\s*(s[ií]|ok|claro|correcto|confirmo|de acuerdo|por supuesto|exacto)(?=$|[^\p{L}])/iu;

const DENIAL_RE = /^\s*(no|incorrecto|nop|nel|negativo|para nada)(?=$|[^\p{L}])/iu;

/** Stable bump when the extractor's prompt template or output schema changes. */
const EXTRACTOR_PROMPT_VERSION = 'extractor.v1';

export interface ExtractInput {
  readonly conversationId: ConversationId;
  readonly userMessage: string;
  readonly activeAgentId: AgentId;
  /** The decision the planner emitted on the previous turn, if any. */
  readonly priorDecision?: PlannerDecision;
  /** Tenant + user + audit fields for the LLM call. */
  readonly llmContext: LlmLoggingContext;
}

export class ChatInputAdapter implements InputAdapter {
  readonly id = 'chat-es';

  constructor(
    private readonly core: OrchestratorCore,
    private readonly registry: AgentRegistry,
  ) {}

  /**
   * Produce a FieldDelta from a user message. Does NOT push it into the
   * core; the controller chooses when to call `applyDelta` (it may want to
   * await dispatch settlement before reading the next decision).
   */
  async extract(input: ExtractInput): Promise<FieldDelta> {
    const { conversationId, userMessage, activeAgentId, priorDecision, llmContext } = input;
    const child = log.child({
      op: 'extract',
      conversationId,
      activeAgentId,
      priorDecisionKind: priorDecision?.kind,
    });

    // 1) Affirmation fast-path on a prior confirm_field.
    if (priorDecision?.kind === 'confirm_field') {
      if (AFFIRMATION_RE.test(userMessage)) {
        child.info(
          { fieldName: priorDecision.fieldName },
          'extractor.fast_path.affirmation',
        );
        return {
          conversationId,
          source: this.id,
          timestamp: new Date().toISOString(),
          fields: {
            [priorDecision.agentId]: {
              [priorDecision.fieldName]: {
                value: priorDecision.pendingValue,
                confidence: 1.0,
                rawInput: userMessage,
              },
            },
          },
        };
      }
      if (DENIAL_RE.test(userMessage)) {
        child.info(
          { fieldName: priorDecision.fieldName },
          'extractor.fast_path.denial',
        );
        return {
          conversationId,
          source: this.id,
          timestamp: new Date().toISOString(),
          fields: {},
          intents: [
            {
              kind: 'reset_field',
              agentId: priorDecision.agentId,
              fieldName: priorDecision.fieldName,
            },
          ],
        };
      }
    }

    // 2) LLM extraction.
    const schema = this.registry.getFieldSchemas().find((s) => s.agentId === activeAgentId);
    if (!schema) {
      throw new Error(`Unknown active agent for extraction: ${activeAgentId}`);
    }

    const fieldEntries = [
      ...schema.requiredFields.map((name) => ({ name, required: true })),
      ...schema.optionalFields.map((name) => ({ name, required: false })),
    ].map((entry) => ({
      ...entry,
      promptHint: this.registry.getPromptHint(activeAgentId, entry.name),
    }));

    const systemPrompt = buildExtractorSystemPrompt(activeAgentId, fieldEntries);
    const resolved = getProvider().resolve('extractor');

    child.info(
      { model: resolved.modelId, fields: fieldEntries.map((f) => f.name) },
      'extractor.llm.start',
    );

    const completion = await withLlmLogging(
      resolved.client,
      {
        model: resolved.modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0,
        max_tokens: 512,
        response_format: { type: 'json_object' },
      },
      { ...llmContext, promptVersion: EXTRACTOR_PROMPT_VERSION, modelRevision: resolved.modelRevision },
    );

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const fields = parseExtractedFields(raw, fieldEntries.map((f) => f.name), child);

    return {
      conversationId,
      source: this.id,
      timestamp: new Date().toISOString(),
      fields: Object.keys(fields).length > 0 ? { [activeAgentId]: fields } : {},
    };
  }

  /**
   * InputAdapter contract: hand the delta to the core. The controller
   * variant can also call `core.applyDelta` directly if it needs the
   * snapshot back; this method exists for the future event-driven flow.
   */
  async submit(delta: FieldDelta): Promise<AdapterSubmitResult> {
    try {
      await this.core.applyDelta(delta);
      return { accepted: true };
    } catch (err) {
      log.error({ err, conversationId: delta.conversationId }, 'submit.failed');
      return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

function buildExtractorSystemPrompt(
  agentId: AgentId,
  fields: ReadonlyArray<{ readonly name: string; readonly required: boolean; readonly promptHint: string }>,
): string {
  const fieldLines = fields
    .map(
      (f) =>
        `  - ${f.name} (${f.required ? 'requerido' : 'opcional'}): ${f.promptHint}`,
    )
    .join('\n');

  return [
    `Eres un extractor de campos para el agente "${agentId}" del orquestador MYPES.`,
    `Tu única tarea: dado un mensaje del usuario en español, extraer los campos listados abajo.`,
    ``,
    `Campos a extraer:`,
    fieldLines,
    ``,
    `Reglas:`,
    `- Devuelve EXCLUSIVAMENTE un objeto JSON con la forma {"fields": {<fieldName>: {"value": string, "confidence": number} | null, ...}}.`,
    `- Si el campo NO está expresado o implicado en el mensaje, usa null en lugar del objeto.`,
    `- "confidence" es un número entre 0.0 y 1.0:`,
    `    1.0  - el usuario indica el valor literalmente`,
    `    0.9  - claramente implicado por el mensaje`,
    `    0.7  - probable pero ambiguo`,
    `    <0.6 - no estás seguro: omite el campo (null)`,
    `- NO inventes valores. NO uses contexto fuera del mensaje del usuario.`,
    `- NO incluyas texto fuera del JSON.`,
  ].join('\n');
}

function parseExtractedFields(
  raw: string,
  expectedFieldNames: ReadonlyArray<string>,
  log: ReturnType<typeof loggerFor>,
): Record<string, FieldValueWithConfidence> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn({ err, raw }, 'extractor.parse.failed');
    return {};
  }

  const fieldsObj =
    parsed && typeof parsed === 'object' && 'fields' in parsed
      ? (parsed as { fields: unknown }).fields
      : parsed;
  if (!fieldsObj || typeof fieldsObj !== 'object') {
    log.warn({ raw }, 'extractor.parse.shape_invalid');
    return {};
  }

  const out: Record<string, FieldValueWithConfidence> = {};
  for (const name of expectedFieldNames) {
    const entry = (fieldsObj as Record<string, unknown>)[name];
    if (!entry || typeof entry !== 'object') continue;
    const value = (entry as Record<string, unknown>).value;
    const confidence = (entry as Record<string, unknown>).confidence;
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    if (typeof confidence !== 'number' || Number.isNaN(confidence)) continue;
    if (confidence < CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM) {
      log.debug({ fieldName: name, confidence }, 'extractor.field.below_threshold');
      continue;
    }
    out[name] = { value: value.trim(), confidence };
    log.debug({ fieldName: name, confidence }, 'extractor.field.accepted');
  }
  return out;
}

