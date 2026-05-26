/**
 * MYPES Platform — Chat input adapter (Layer 1: Extractor)
 * =========================================================
 *
 * Location: src/adapters/chat-input-adapter.ts
 *
 * Converts a user's Spanish chat turn into a `FieldDelta` against the union
 * of every registered agent's field schema. The extractor is agent-agnostic:
 * it does NOT know which agent the wizard is currently on. It asks the LLM
 * to ground every field declared by any registered card; when a value is
 * grounded, it is fanned out to every agent that requires it. Order of
 * dispatch is the planner's job.
 *
 * Two paths:
 *
 *   1. Affirmation / denial fast-path: when the prior planner decision was
 *      `confirm_field`, regex matches on "sí/ok/confirmo/..." or
 *      "no/incorrecto/..." short-circuit the LLM. The pending value (or
 *      reset) is fanned out to every agent that owns the field.
 *
 *   2. LLM extraction: otherwise, calls Gemini Flash with a deduped union
 *      of every required + optional field name across all agents. The
 *      response is parsed, low-confidence values are dropped against
 *      `CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM`, and the survivors are
 *      fanned out to their owners.
 *
 * Contract conformance: implements `InputAdapter` (id + submit). Controllers
 * call `extract()` directly to obtain a delta, then either feed it through
 * `submit()` or hand it to `OrchestratorCore.applyDelta()` themselves.
 *
 * The orchestrator core does NOT import this file — modality stays at the
 * boundary (architecture skill rule 1).
 */

import { z } from 'zod';
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

const EXTRACTOR_TOOL_NAME = 'submit_extracted_fields';

// Note: `\b` would not work between `í` and `,` because JS regex treats
// non-ASCII letters as non-word characters by default. We anchor on `^\s*`
// + the keyword + a non-letter terminator instead.
const AFFIRMATION_RE = /^\s*(s[ií]|ok|claro|correcto|confirmo|de acuerdo|por supuesto|exacto)(?=$|[^\p{L}])/iu;

const DENIAL_RE = /^\s*(no|incorrecto|nop|nel|negativo|para nada)(?=$|[^\p{L}])/iu;

/** Stable bump when the extractor's prompt template or output schema changes. */
const EXTRACTOR_PROMPT_VERSION = 'extractor.v3';

export interface ExtractInput {
  readonly conversationId: ConversationId;
  readonly userMessage: string;
  /** The decision the planner emitted on the previous turn, if any. */
  readonly priorDecision?: PlannerDecision;
  /** Tenant + user + audit fields for the LLM call. */
  readonly llmContext: LlmLoggingContext;
}

interface FieldOwnership {
  readonly agents: ReadonlyArray<AgentId>;
  readonly required: boolean;
  readonly promptHint: string;
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
    const { conversationId, userMessage, priorDecision, llmContext } = input;
    const child = log.child({
      op: 'extract',
      conversationId,
      priorDecisionKind: priorDecision?.kind,
    });

    const ownership = buildFieldOwnership(this.registry);

    child.info(
      {
        contract: 'ExtractInput',
        userMessagePreview: previewMessage(userMessage),
        userMessageLength: userMessage.length,
        priorDecision: priorDecision
          ? {
              kind: priorDecision.kind,
              agentId: 'agentId' in priorDecision ? priorDecision.agentId : undefined,
              fieldName: 'fieldName' in priorDecision ? priorDecision.fieldName : undefined,
            }
          : undefined,
        knownFields: [...ownership.keys()],
      },
      'extractor.input',
    );

    const emitOutput = (delta: FieldDelta, path: 'fast_path.affirmation' | 'fast_path.denial' | 'llm') => {
      child.info(
        {
          contract: 'FieldDelta',
          path,
          source: delta.source,
          fields: Object.fromEntries(
            Object.entries(delta.fields).map(([agentId, fields]) => [
              agentId,
              Object.fromEntries(
                Object.entries(fields).map(([name, v]) => [
                  name,
                  { confidence: v.confidence, valuePreview: previewMessage(String(v.value)) },
                ]),
              ),
            ]),
          ),
          intents: (delta.intents ?? []).map((i) => ({
            kind: i.kind,
            agentId: 'agentId' in i ? i.agentId : undefined,
          })),
        },
        'extractor.output',
      );
      return delta;
    };

    // 1) Affirmation / denial fast-path on a prior confirm_field.
    if (priorDecision?.kind === 'confirm_field') {
      const owners =
        ownership.get(priorDecision.fieldName)?.agents ?? [priorDecision.agentId];

      if (AFFIRMATION_RE.test(userMessage)) {
        child.info(
          { fieldName: priorDecision.fieldName, owners },
          'extractor.fast_path.affirmation',
        );
        const fields: Record<string, Record<string, FieldValueWithConfidence>> = {};
        for (const agentId of owners) {
          fields[agentId] = {
            [priorDecision.fieldName]: {
              value: priorDecision.pendingValue,
              confidence: 1.0,
              rawInput: userMessage,
            },
          };
        }
        return emitOutput(
          {
            conversationId,
            source: this.id,
            timestamp: new Date().toISOString(),
            fields,
          },
          'fast_path.affirmation',
        );
      }
      if (DENIAL_RE.test(userMessage)) {
        child.info(
          { fieldName: priorDecision.fieldName, owners },
          'extractor.fast_path.denial',
        );
        return emitOutput(
          {
            conversationId,
            source: this.id,
            timestamp: new Date().toISOString(),
            fields: {},
            intents: owners.map((agentId) => ({
              kind: 'reset_field' as const,
              agentId,
              fieldName: priorDecision.fieldName,
            })),
          },
          'fast_path.denial',
        );
      }
    }

    // 2) LLM extraction over the deduped union of fields.
    // Lex-sort field entries so the schema, prompt, and logs are deterministic.
    const fieldEntries = [...ownership.entries()]
      .map(([name, entry]) => ({
        name,
        required: entry.required,
        promptHint: entry.promptHint,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (fieldEntries.length === 0) {
      child.warn('extractor.no_fields_registered');
      return emitOutput(
        {
          conversationId,
          source: this.id,
          timestamp: new Date().toISOString(),
          fields: {},
        },
        'llm',
      );
    }

    const fieldNames = fieldEntries.map((f) => f.name);
    const extractedSchema = buildExtractedFieldsSchema(fieldNames);
    const toolJsonSchema = z.toJSONSchema(extractedSchema, { target: 'draft-7' });
    const systemPrompt = buildExtractorSystemPrompt(fieldEntries);
    const resolved = getProvider().resolve('extractor');

    // Surface the schema the API call is about to be forced into. Pair this
    // with `extractor.llm.raw_response` and `extractor.parse.result` to see
    // the full first-conversion trace: schema in → tool args out → validated.
    child.info(
      {
        model: resolved.modelId,
        fields: fieldEntries,
        toolName: EXTRACTOR_TOOL_NAME,
        jsonSchema: toolJsonSchema,
      },
      'extractor.llm.schema',
    );

    child.info(
      { model: resolved.modelId, fields: fieldNames },
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
        tools: [
          {
            type: 'function',
            function: {
              name: EXTRACTOR_TOOL_NAME,
              description:
                'Submit the fields you grounded from the user message. Pass null for fields not expressed or implied.',
              parameters: toolJsonSchema as Record<string, unknown>,
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: EXTRACTOR_TOOL_NAME },
        },
      },
      { ...llmContext, promptVersion: EXTRACTOR_PROMPT_VERSION, modelRevision: resolved.modelRevision },
    );

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
    const rawArgs =
      toolCall && toolCall.type === 'function' ? toolCall.function.arguments : '';
    child.info(
      {
        toolName:
          toolCall && toolCall.type === 'function' ? toolCall.function.name : undefined,
        rawLength: rawArgs.length,
        rawPreview: rawArgs.length > 400 ? `${rawArgs.slice(0, 397)}...` : rawArgs,
      },
      'extractor.llm.raw_response',
    );

    const groundedFields = validateAndFilterExtractedFields(
      rawArgs,
      extractedSchema,
      child,
    );

    // Fan out: each grounded logical field is written into every agent that
    // requires (or optionally accepts) it.
    const fields: Record<string, Record<string, FieldValueWithConfidence>> = {};
    for (const [fieldName, value] of Object.entries(groundedFields)) {
      const owners = ownership.get(fieldName)?.agents ?? [];
      for (const agentId of owners) {
        const bucket = (fields[agentId] ??= {});
        bucket[fieldName] = value;
      }
    }

    return emitOutput(
      {
        conversationId,
        source: this.id,
        timestamp: new Date().toISOString(),
        fields,
      },
      'llm',
    );
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

/**
 * Walk every registered card and build a logical-field → owners map.
 * Same field name across multiple agents is deduped: the LLM is asked
 * about each logical field once. Required wins over optional if any
 * agent marks the field required.
 */
function buildFieldOwnership(registry: AgentRegistry): Map<string, FieldOwnership> {
  const out = new Map<string, { agents: AgentId[]; required: boolean; promptHint: string }>();
  for (const schema of registry.getFieldSchemas()) {
    for (const fieldName of schema.requiredFields) {
      const entry = out.get(fieldName);
      const hint = registry.getPromptHint(schema.agentId, fieldName);
      if (entry) {
        entry.agents.push(schema.agentId);
        entry.required = true;
      } else {
        out.set(fieldName, { agents: [schema.agentId], required: true, promptHint: hint });
      }
    }
    for (const fieldName of schema.optionalFields) {
      const entry = out.get(fieldName);
      const hint = registry.getPromptHint(schema.agentId, fieldName);
      if (entry) {
        entry.agents.push(schema.agentId);
      } else {
        out.set(fieldName, { agents: [schema.agentId], required: false, promptHint: hint });
      }
    }
  }
  return out;
}

function previewMessage(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function buildExtractorSystemPrompt(
  fields: ReadonlyArray<{ readonly name: string; readonly required: boolean; readonly promptHint: string }>,
): string {
  const fieldLines = fields
    .map(
      (f) =>
        `  - ${f.name} (${f.required ? 'requerido' : 'opcional'}): ${f.promptHint}`,
    )
    .join('\n');

  return [
    `Eres un extractor de campos para el orquestador MYPES.`,
    `Tu única tarea: dado un mensaje del usuario en español, llama a la función "${EXTRACTOR_TOOL_NAME}" con los campos que puedas extraer.`,
    `Estos campos pertenecen al conjunto de agentes registrados; el orquestador decidirá qué agente despachar.`,
    ``,
    `Campos disponibles:`,
    fieldLines,
    ``,
    `Reglas:`,
    `- Si el campo NO está expresado o implicado en el mensaje, pasa null en ese campo.`,
    `- "confidence" es un número entre 0.0 y 1.0:`,
    `    1.0  - el usuario indica el valor literalmente`,
    `    0.9  - claramente implicado por el mensaje`,
    `    0.7  - probable pero ambiguo`,
    `    <0.6 - no estás seguro: pasa null en ese campo`,
    `- NO inventes valores. NO uses contexto fuera del mensaje del usuario.`,
    `- Llama a la función exactamente una vez. No incluyas texto adicional.`,
  ].join('\n');
}

const FieldValueZ = z
  .object({
    value: z.string().min(1),
    confidence: z.number().min(0).max(1),
  })
  .nullable();

/**
 * Build a Zod schema describing exactly the field union the extractor was
 * configured with. Sent verbatim to the LLM as a tool's `parameters` schema
 * (after JSON-schema conversion) and reused to validate the tool arguments
 * the model returns.
 */
function buildExtractedFieldsSchema(fieldNames: ReadonlyArray<string>) {
  const shape: Record<string, typeof FieldValueZ> = {};
  for (const name of fieldNames) {
    shape[name] = FieldValueZ;
  }
  return z
    .object({
      fields: z.object(shape),
    })
    .strict();
}

function validateAndFilterExtractedFields(
  rawArgs: string,
  schema: ReturnType<typeof buildExtractedFieldsSchema>,
  log: ReturnType<typeof loggerFor>,
): Record<string, FieldValueWithConfidence> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs.length > 0 ? rawArgs : '{}');
  } catch (err) {
    log.warn(
      { err: (err as Error).message, rawPreview: rawArgs.slice(0, 400) },
      'extractor.parse.failed',
    );
    return {};
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    log.warn(
      {
        issues: result.error.issues,
        rawPreview: rawArgs.slice(0, 400),
      },
      'extractor.parse.failed',
    );
    return {};
  }

  // Surface the validated, pre-threshold conversion: this is exactly what the
  // model produced after schema enforcement, before any low-confidence drops.
  log.info(
    {
      contract: 'ExtractedFields',
      fields: Object.fromEntries(
        Object.entries(result.data.fields).map(([name, slot]) => [
          name,
          slot === null
            ? null
            : {
                confidence: slot.confidence,
                valuePreview: previewMessage(slot.value),
              },
        ]),
      ),
    },
    'extractor.parse.result',
  );

  const out: Record<string, FieldValueWithConfidence> = {};
  for (const [name, slot] of Object.entries(result.data.fields)) {
    if (slot === null) continue;
    if (slot.confidence < CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM) {
      log.debug(
        { fieldName: name, confidence: slot.confidence },
        'extractor.field.below_threshold',
      );
      continue;
    }
    out[name] = { value: slot.value.trim(), confidence: slot.confidence };
    log.debug({ fieldName: name, confidence: slot.confidence }, 'extractor.field.accepted');
  }
  return out;
}
