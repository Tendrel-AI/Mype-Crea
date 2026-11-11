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
 *      `confirm_field` and the message is ONLY a yes ("sí", "correcto",
 *      "dale", "sí, así es") or ONLY a no ("no", "no, ese no es"), the LLM
 *      is skipped. The pending value (or reset) is fanned out to every agent
 *      that owns the field.
 *
 *   2. LLM extraction: otherwise, calls the extractor model with a deduped
 *      union of every required + optional field name across all agents. The
 *      response is parsed, low-confidence values are dropped against
 *      `CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM`, and the survivors are
 *      fanned out to their owners.
 *
 *      When a `confirm_field` was pending and the message opens with a yes
 *      or a no but carries more ("sí, y mis colores son azul y blanco",
 *      "no, se llama Dulce Casa"), the extraction runs and its result is
 *      combined with the reply (`resolveCompoundConfirmation`):
 *        - yes, field not restated (or restated with the pending value)
 *          → the pending value is confirmed;
 *        - the field restated with a DIFFERENT value (after a yes or a no)
 *          → the pending value is never confirmed: the field is reset, and
 *          the new value rides in the same delta when it clears
 *          STORE_AND_CONFIRM;
 *        - no, without a usable replacement → the field is reset.
 *      Merge applies `reset_field` before field values, so reset + new value
 *      means "replace": the correction wins even when it is less confident
 *      than the pending value it replaces.
 *      Extra facts follow the normal extraction rules; unknown fields are
 *      stripped by the parser and rejected by merge, as for any turn.
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
  type ConfirmFieldDecision,
  type ConversationId,
  type FieldDelta,
  type InputAdapter,
  type OrchestratorCore,
  type PlannerDecision,
  type RequestFieldsDecision,
  type AdapterSubmitResult,
  type FieldValueWithConfidence,
  type UserIntent,
} from '../core/contracts';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';
import { getProvider } from '../services/llm';
import {
  assertResolvedModelPurpose,
  type AdapterExecution,
  type AdapterFieldBehavior,
} from '../services/ai-config/adapter-behavior';
import { resolveAdapterBehavior } from '../services/prompts/adapter-behavior';
import type { PromptVersions } from '../services/prompts';
import { withLlmLogging, type LlmLoggingContext } from '../services/llm-logger';
import { loggerFor } from '../services/logger';

const log = loggerFor('adapter.chat-input');

// Leading cue: does the reply OPEN with a yes / no? Gives the polarity of a
// compound reply ("sí, y ...", "no, se llama ...").
// Note: `\b` would not work between `í` and `,` because JS regex treats
// non-ASCII letters as non-word characters by default. We anchor on `^\s*`
// + the keyword + a non-letter terminator instead.
const AFFIRMATION_RE =
  /^\s*(s[ií]|ok|okey|okay|claro|correcto|confirmo|de acuerdo|por supuesto|exacto|dale|perfecto|listo|as[ií] es)(?=$|[^\p{L}])/iu;

const DENIAL_RE = /^\s*(no|incorrecto|nop|nel|negativo|para nada)(?=$|[^\p{L}])/iu;

// Whole-message vocabularies for the fast path, in the form produced by
// `normalizeReply` (lowercase, no accents, words joined by one space). A reply
// takes the fast path only when it is a sequence of these phrases and nothing
// else; any other content goes through the LLM.
const AFFIRMATION_PHRASES = [
  'si', 'ok', 'okey', 'okay', 'claro', 'claro que si', 'correcto', 'es correcto', 'esta correcto',
  'confirmo', 'lo confirmo', 'de acuerdo', 'por supuesto', 'exacto', 'exactamente', 'dale',
  'perfecto', 'listo', 'asi es', 'eso es', 'ese es', 'esta bien', 'asi esta bien', 'todo bien',
];
const DENIAL_PHRASES = [
  'no', 'nop', 'nel', 'negativo', 'para nada', 'incorrecto', 'es incorrecto', 'no es correcto',
  'no es asi', 'no es', 'ese no es', 'eso no es', 'no es ese', 'no es eso', 'esta mal',
];
const MAX_SIMPLE_REPLY_LENGTH = 60;
/** Courtesy words that may accompany either answer without changing it. */
const COURTESY_PHRASES = ['gracias', 'muchas gracias', 'por favor'];

const SIMPLE_AFFIRMATION_RE = wholeReplyRe(AFFIRMATION_PHRASES, COURTESY_PHRASES);
const SIMPLE_DENIAL_RE = wholeReplyRe(DENIAL_PHRASES, COURTESY_PHRASES);
/** Only yes/no words, but of both kinds ("sí, no"): ambiguous, so no polarity. */
const MIXED_YES_NO_RE = wholeReplyRe([...AFFIRMATION_PHRASES, ...DENIAL_PHRASES], COURTESY_PHRASES);

function wholeReplyRe(answers: ReadonlyArray<string>, courtesy: ReadonlyArray<string>): RegExp {
  // Longest first so "claro que si" wins over "claro".
  const byLength = (list: ReadonlyArray<string>) => [...list].sort((a, b) => b.length - a.length).join('|');
  const any = byLength([...answers, ...courtesy]);
  // At least one real answer phrase; courtesy words alone carry no polarity.
  return new RegExp(`^(?:(?:${any}) )*(?:${byLength(answers)})(?: (?:${any}))*$`);
}

/** Lowercase, strip accents, and collapse everything but letters/digits to single spaces. */
function normalizeReply(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface ConfirmationReply {
  /** Whether the reply says yes, no, or neither to the pending value. */
  readonly polarity: 'affirm' | 'deny' | 'none';
  /** True when the reply is ONLY a yes or ONLY a no: fast path, no LLM call. */
  readonly simple: boolean;
}

/**
 * Classify a reply to a `confirm_field` question. A simple reply takes the
 * fast path. Any other reply is extracted by the LLM, and its polarity comes
 * from the opening word (`polarity: 'none'` when there is no yes/no cue or
 * the yes/no words contradict each other).
 */
export function classifyConfirmationReply(message: string): ConfirmationReply {
  const normalized = normalizeReply(message);
  // A bare yes/no is short; the cap also bounds regex backtracking on long input.
  if (normalized.length <= MAX_SIMPLE_REPLY_LENGTH) {
    if (SIMPLE_AFFIRMATION_RE.test(normalized)) return { polarity: 'affirm', simple: true };
    if (SIMPLE_DENIAL_RE.test(normalized)) return { polarity: 'deny', simple: true };
    if (MIXED_YES_NO_RE.test(normalized)) return { polarity: 'none', simple: false };
  }
  if (AFFIRMATION_RE.test(message)) return { polarity: 'affirm', simple: false };
  if (DENIAL_RE.test(message)) return { polarity: 'deny', simple: false };
  return { polarity: 'none', simple: false };
}

/** Two values name the same thing when they match after `normalizeReply`. */
function sameFieldValue(a: unknown, b: unknown): boolean {
  return normalizeReply(String(a)) === normalizeReply(String(b));
}

export interface ExtractInput {
  readonly conversationId: ConversationId;
  readonly userMessage: string;
  /** The decision the planner emitted on the previous turn, if any. */
  readonly priorDecision?: PlannerDecision;
  /** Tenant + user + audit fields for the LLM call. */
  readonly llmContext: LlmLoggingContext;
  /** Explicit frozen execution for product turns; omitted by legacy/eval callers. */
  readonly execution?: AdapterExecution;
  /** The conversation's pinned prompt versions (D22); omitted = the active versions. */
  readonly promptVersions?: PromptVersions;
  /**
   * KAN-44: told about every field the model returned that this turn did not
   * ask for (outside the catalog, e.g. `tenant_id`, or not in the frozen
   * release). They are never stored; the controller logs the refusal.
   */
  readonly onUnaskedFields?: (fields: ReadonlyArray<{ readonly name: string; readonly value: unknown }>) => void;
}

interface FieldOwnership {
  readonly agents: ReadonlyArray<AgentId>;
  readonly required: boolean;
  readonly promptHint: string;
}

type ExtractPath =
  | 'fast_path.affirmation'
  | 'fast_path.denial'
  | 'llm'
  | 'llm.compound_confirmation';

type MutableFieldValues = Record<string, Record<string, FieldValueWithConfidence>>;

/** A `confirm_field` the user answered with more than a bare yes/no. */
interface PendingConfirmation {
  readonly decision: ConfirmFieldDecision;
  readonly owners: ReadonlyArray<AgentId>;
  readonly polarity: ConfirmationReply['polarity'];
}

/** Write the pending value as user-confirmed (confidence 1.0) on every owner. */
function confirmPendingValue(
  fields: MutableFieldValues,
  decision: ConfirmFieldDecision,
  owners: ReadonlyArray<AgentId>,
  rawInput: string,
): void {
  for (const agentId of owners) {
    (fields[agentId] ??= {})[decision.fieldName] = {
      value: decision.pendingValue,
      confidence: 1.0,
      rawInput,
      // A stale «sí» (the value changed since the question) must not overwrite.
      expectedPendingValue: decision.pendingValue,
    };
  }
}

/**
 * Reset intents for a reply that rejects the pending value. A bare rejection
 * only applies while that value is still pending; a reply that carries a
 * correction (`withCorrection`) resets unconditionally, so an explicit
 * correction replaces whatever the field holds now.
 */
function resetIntents(
  decision: ConfirmFieldDecision,
  owners: ReadonlyArray<AgentId>,
  withCorrection = false,
): UserIntent[] {
  return owners.map((agentId) => ({
    kind: 'reset_field' as const,
    agentId,
    fieldName: decision.fieldName,
    ...(withCorrection ? {} : { expectedPendingValue: decision.pendingValue }),
  }));
}

function dropField(fields: MutableFieldValues, fieldName: string, owners: ReadonlyArray<AgentId>): void {
  for (const agentId of owners) {
    const bucket = fields[agentId];
    if (!bucket) continue;
    delete bucket[fieldName];
    if (Object.keys(bucket).length === 0) delete fields[agentId];
  }
}

/**
 * Combine a compound reply to `confirm_field` with what the LLM extracted.
 * Mutates `fields` (already fanned out) for the field under confirmation and
 * returns the intents to emit. Every other extracted field is left as is.
 *
 * - polarity 'none': no yes/no cue → plain extraction, nothing changes.
 * - yes, no contradiction → the pending value is confirmed at 1.0.
 * - Anything else resets the field. The pending value is never confirmed.
 *   - The field restated with a value other than the pending one (after a
 *     yes or a no) is a correction: its value, if it cleared
 *     STORE_AND_CONFIRM, stays next to the reset. Merge applies resets
 *     before values, so the correction replaces the pending value whatever
 *     its confidence.
 *   - A no that restates the pending value (or nothing) drops that value, so
 *     the denial wins.
 */
function resolveCompoundConfirmation(
  pending: PendingConfirmation,
  fields: MutableFieldValues,
  mentioned: Readonly<Record<string, string>>,
  rawInput: string,
  logger: ReturnType<typeof loggerFor>,
): UserIntent[] {
  const { decision, owners, polarity } = pending;
  const fieldName = decision.fieldName;
  if (polarity === 'none') {
    logger.info({ fieldName, outcome: 'no_cue' }, 'extractor.confirm.resolved');
    return [];
  }

  const restated = mentioned[fieldName];
  const contradicted = restated !== undefined && !sameFieldValue(restated, decision.pendingValue);

  if (polarity === 'affirm' && !contradicted) {
    confirmPendingValue(fields, decision, owners, rawInput);
    logger.info({ fieldName, polarity, outcome: 'confirmed' }, 'extractor.confirm.resolved');
    return [];
  }
  // From here the pending value must not survive. A different value restated
  // in the reply (if it cleared STORE_AND_CONFIRM) replaces it; the same value
  // restated after a no is dropped so the denial wins.
  if (!contradicted) dropField(fields, fieldName, owners);
  const correctionKept = owners.some((agentId) => fields[agentId]?.[fieldName] !== undefined);
  logger.info(
    { fieldName, polarity, contradicted, outcome: correctionKept ? 'corrected' : 'reset' },
    'extractor.confirm.resolved',
  );
  return resetIntents(decision, owners, correctionKept);
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
    const { conversationId, userMessage, priorDecision, llmContext, execution, promptVersions } = input;
    const child = log.child({
      op: 'extract',
      conversationId,
      priorDecisionKind: priorDecision?.kind,
    });

    const ownership = buildFieldOwnership(this.registry);
    const currentFields = adapterFieldsFromOwnership(ownership);
    // D22: the prompt comes from the frozen file (pinned version, else active); the support gate runs inside.
    const behavior = resolveAdapterBehavior('extractor', promptVersions, currentFields, execution);
    if (execution) assertResolvedModelPurpose(execution.model, 'extractor');

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

    const emitOutput = (delta: FieldDelta, path: ExtractPath) => {
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

    // 1) Reply to a prior confirm_field: a bare yes/no takes the fast path;
    //    anything more is extracted below and combined with the reply.
    let pendingConfirmation: PendingConfirmation | undefined;
    if (priorDecision?.kind === 'confirm_field') {
      const owners =
        ownership.get(priorDecision.fieldName)?.agents ?? [priorDecision.agentId];
      const reply = classifyConfirmationReply(userMessage);

      if (reply.simple && reply.polarity === 'affirm') {
        child.info(
          { fieldName: priorDecision.fieldName, owners },
          'extractor.fast_path.affirmation',
        );
        const fields: Record<string, Record<string, FieldValueWithConfidence>> = {};
        confirmPendingValue(fields, priorDecision, owners, userMessage);
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
      if (reply.simple && reply.polarity === 'deny') {
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
            intents: resetIntents(priorDecision, owners),
          },
          'fast_path.denial',
        );
      }
      pendingConfirmation = { decision: priorDecision, owners, polarity: reply.polarity };
      child.info(
        { fieldName: priorDecision.fieldName, owners, polarity: reply.polarity },
        'extractor.confirm.compound',
      );
    }

    // 2) LLM extraction over the deduped union of fields.
    // Lex-sort field entries so the schema, prompt, and logs are deterministic.
    const fieldEntries = behavior.extractor.fields;
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
    const toolJsonSchema = renderExtractorToolSchema(
      behavior.extractor.fieldSchemaTemplate,
      fieldNames,
      extractedSchema,
    );
    const systemPrompt = renderExtractorSystemPrompt(
      behavior.extractor.promptTemplate,
      behavior.extractor.toolName,
      fieldEntries,
      priorDecision?.kind === 'request_fields' ? priorDecision : undefined,
    );
    const resolved = execution?.model ?? getProvider().resolve('extractor');

    // Surface the schema the API call is about to be forced into. Pair this
    // with `extractor.llm.raw_response` and `extractor.parse.result` to see
    // the full first-conversion trace: schema in → tool args out → validated.
    child.info(
      {
        model: resolved.modelId,
        fields: fieldEntries,
        toolName: behavior.extractor.toolName,
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
        temperature: behavior.extractor.temperature,
        max_tokens: behavior.extractor.maxTokens,
        tools: [
          {
            type: 'function',
            function: {
              name: behavior.extractor.toolName,
              description: behavior.extractor.toolDescription,
              parameters: toolJsonSchema as Record<string, unknown>,
            },
          },
        ],
        tool_choice: behavior.extractor.toolChoice,
      },
      { ...llmContext, promptVersion: behavior.extractor.promptVersion, modelRevision: resolved.modelRevision, provider: resolved.provider ?? 'openrouter', purpose: 'extractor' },
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

    const { accepted: groundedFields, mentioned, unasked } = validateAndFilterExtractedFields(
      rawArgs,
      extractedSchema,
      fieldNames,
      child,
    );
    if (unasked.length > 0) {
      child.warn({ unaskedFields: unasked.map((f) => f.name.slice(0, 64)) }, 'extractor.parse.unasked_fields');
      input.onUnaskedFields?.(unasked);
    }

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

    if (pendingConfirmation) {
      const intents = resolveCompoundConfirmation(
        pendingConfirmation,
        fields,
        mentioned,
        userMessage,
        child,
      );
      return emitOutput(
        {
          conversationId,
          source: this.id,
          timestamp: new Date().toISOString(),
          fields,
          ...(intents.length > 0 ? { intents } : {}),
        },
        'llm.compound_confirmation',
      );
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

function renderExtractorSystemPrompt(
  template: string,
  toolName: string,
  fields: ReadonlyArray<AdapterFieldBehavior>,
  asked?: RequestFieldsDecision,
): string {
  // Same order as the Responder's numbered list: number i = fields[i-1].
  const askedBlock = asked
    ? `\nPreguntas pendientes (el usuario puede responder por número):\n${asked.fields
        .map((f, i) => `  ${i + 1}. ${f.fieldName}: ${f.promptHint}`)
        .join('\n')}`
    : '';
  const fieldLines = fields
    .map(
      (f) =>
        `  - ${f.name} (${f.required ? 'requerido' : 'opcional'}): ${f.promptHint}`,
    )
    .join('\n');

  return template
    .replaceAll('{{toolName}}', toolName)
    .replaceAll('{{fieldLines}}', fieldLines)
    .replaceAll('{{askedBlock}}', askedBlock);
}

function adapterFieldsFromOwnership(ownership: Map<string, FieldOwnership>): AdapterFieldBehavior[] {
  return [...ownership.entries()]
    .map(([name, entry]) => ({
      name,
      required: entry.required,
      promptHint: entry.promptHint,
      agents: [...entry.agents].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderExtractorToolSchema(
  template: Readonly<Record<string, unknown>>,
  fieldNames: ReadonlyArray<string>,
  parserSchema: ReturnType<typeof buildExtractedFieldsSchema>,
): Record<string, unknown> {
  const generated = z.toJSONSchema(parserSchema, { target: 'draft-7' }) as Record<string, unknown>;
  const expected = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
  const expectedProperties = expected.properties as Record<string, unknown>;
  const expectedFields = expectedProperties.fields as Record<string, unknown>;
  const actualProperties = generated.properties as Record<string, unknown>;
  const actualFields = actualProperties.fields as Record<string, unknown>;
  expectedFields.properties = actualFields.properties;
  expectedFields.required = [...fieldNames];
  if (JSON.stringify(sortObject(expected)) !== JSON.stringify(sortObject(generated))) {
    throw new Error('Frozen extractor tool schema does not match the supported parser schema.');
  }
  return generated;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)]),
    );
  }
  return value;
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

interface ExtractedFields {
  /** Values that cleared STORE_AND_CONFIRM: these go into the delta. */
  readonly accepted: Record<string, FieldValueWithConfidence>;
  /**
   * Every non-null value the model returned, whatever its confidence. Only
   * used to notice that a pending value was contradicted; never stored.
   */
  readonly mentioned: Record<string, string>;
  /** Keys the model returned that were not asked for (KAN-44); the schema strips them. */
  readonly unasked: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
}

function validateAndFilterExtractedFields(
  rawArgs: string,
  schema: ReturnType<typeof buildExtractedFieldsSchema>,
  fieldNames: ReadonlyArray<string>,
  log: ReturnType<typeof loggerFor>,
): ExtractedFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs.length > 0 ? rawArgs : '{}');
  } catch (err) {
    log.warn(
      { err: (err as Error).message, rawPreview: rawArgs.slice(0, 400) },
      'extractor.parse.failed',
    );
    return { accepted: {}, mentioned: {}, unasked: [] };
  }

  const returned = (parsed as { fields?: unknown } | null)?.fields;
  const unasked =
    returned && typeof returned === 'object' && !Array.isArray(returned)
      ? Object.entries(returned)
          .filter(([name]) => !fieldNames.includes(name))
          .map(([name, value]) => ({ name, value }))
      : [];

  const result = schema.safeParse(parsed);
  if (!result.success) {
    log.warn(
      {
        issues: result.error.issues,
        rawPreview: rawArgs.slice(0, 400),
      },
      'extractor.parse.failed',
    );
    return { accepted: {}, mentioned: {}, unasked };
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
  const mentioned: Record<string, string> = {};
  for (const [name, slot] of Object.entries(result.data.fields)) {
    if (slot === null) continue;
    mentioned[name] = slot.value.trim();
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
  return { accepted: out, mentioned, unasked };
}
