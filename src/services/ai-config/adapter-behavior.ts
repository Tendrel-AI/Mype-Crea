import type { ResolvedModel } from '../llm/types';

/**
 * Serializable behavior consumed by the chat adapters. Renderer/parser IDs are
 * runtime compatibility gates: a frozen release is executable only while the
 * code that implements those IDs is present.
 */
export interface AdapterFieldBehavior {
  readonly name: string;
  readonly required: boolean;
  readonly promptHint: string;
  readonly agents: ReadonlyArray<string>;
}

export interface AdapterBehaviorSnapshot {
  readonly schemaVersion: 'adapter-behavior.v1';
  readonly extractor: {
    readonly promptVersion: string;
    /** Full prompt template. `{{toolName}}` and `{{fieldLines}}` are renderer slots. */
    readonly promptTemplate: string;
    readonly rendererVersion: string;
    readonly parserVersion: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly toolName: string;
    readonly toolDescription: string;
    readonly toolChoice: { readonly type: 'function'; readonly function: { readonly name: string } };
    /** JSON Schema with `{{fieldProperties}}` and `{{requiredFields}}` renderer slots. */
    readonly fieldSchemaTemplate: Readonly<Record<string, unknown>>;
    readonly fields: ReadonlyArray<AdapterFieldBehavior>;
    readonly fastPathVersion: string;
    readonly historyPolicyVersion: 'none';
  };
  readonly responder: {
    readonly promptVersion: string;
    /** Full system prompt template. Renderer slots are documented in the renderer. */
    readonly promptTemplate: string;
    readonly rendererVersion: string;
    readonly parserVersion: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly historyLimit: number;
    readonly historyPolicyVersion: string;
    /** Every static prompt fragment inserted by the supported responder renderer. */
    readonly promptFragments: Readonly<Record<string, string>>;
  };
}

export interface AdapterExecution {
  /** Exact, purpose-specific provider/model resolution supplied by the caller. */
  readonly model: ResolvedModel;
  /** Frozen behavior selected for this conversation/turn. */
  readonly behavior: AdapterBehaviorSnapshot;
}

const EXTRACTOR_PROMPT_TEMPLATE = [
  `Eres un extractor de campos para el orquestador MYPES.`,
  `Tu única tarea: dado un mensaje del usuario en español, llama a la función "{{toolName}}" con los campos que puedas extraer.`,
  `Estos campos pertenecen al conjunto de agentes registrados; el orquestador decidirá qué agente despachar.`,
  ``,
  `Campos disponibles:`,
  `{{fieldLines}}`,
  ``,
  `Reglas:`,
  `- Si el campo NO está expresado o implicado en el mensaje, pasa null en ese campo.`,
  `- "confidence" es un número entre 0.0 y 1.0:`,
  `    1.0  - el usuario indica el valor literalmente`,
  `    0.9  - claramente implicado por el mensaje`,
  `    0.7  - probable pero ambiguo`,
  `    <0.6 - no estás seguro: pasa null en ese campo`,
  `- NO inventes valores. NO uses contexto fuera del mensaje del usuario.`,
  `- Si formulas texto, usa español neutro latinoamericano, trata al usuario de tú y nunca uses voseo, aunque el usuario lo use. Conserva literalmente nombres propios y valores expresados.`,
  `- Llama a la función exactamente una vez. No incluyas texto adicional.`,
].join('\n');

const EXTRACTOR_FIELD_SCHEMA_TEMPLATE = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['fields'],
  properties: {
    fields: {
      type: 'object',
      additionalProperties: false,
      properties: '{{fieldProperties}}',
      required: '{{requiredFields}}',
    },
  },
} as const;

const RESPONDER_PROMPT_TEMPLATE = `{{persona}}\n\n{{stateHeading}}\n{{decisionsBlock}}{{progressBlock}}\n{{guardrails}}`;

/**
 * KAN-28 (KAN-64 Option B): generation starts only from typed panel buttons.
 * These fragments were introduced in `responder.chat-step1.v6`. Frozen
 * releases created before that do not carry them, so the renderer falls back
 * to these defaults (`RESPONDER_FRAGMENT_FALLBACKS`): an older release must
 * still be able to render `offer_generation`, and its users must still be
 * pointed at the buttons now that chat can no longer start a generation.
 * They are deliberately NOT part of the required-fragment validation below.
 */
const RESPONDER_COMMAND_FRAGMENTS = {
  offerGenerationDecision: `{{kind}}\nDecisión: el entregable "{{deliverableLabel}}" del agente "{{agentId}}" ya tiene todo lo necesario. La generación NO empieza sola: el usuario debe tocar el botón Generar del panel.\nAcción obligatoria: en UNA sola frase, dile que ya tiene todo listo y que, cuando quiera, toque el botón Generar (por ejemplo "Ya tienes todo listo para tu logo. Cuando quieras, toca el botón Generar."). PROHIBIDO decir que ya empezaste a generar o que estás generando.`,
  commandGuidanceGuardrail: `- Generar, Iterar, Aprobar, Reintentar y Cancelar son botones del panel. Tú NO puedes ejecutarlos desde el chat: nunca digas que ya generaste, cambiaste, aprobaste o cancelaste algo. Si el usuario pide en el chat un cambio, otra versión o una aprobación de un entregable, guíalo al botón correspondiente, por ejemplo: "Para ajustar este logo, toca el botón Iterar y escribe qué quieres cambiar." o "Si te gusta, toca el botón Aprobar.".`,
} as const;

export const RESPONDER_FRAGMENT_FALLBACKS: Readonly<Record<string, string>> = RESPONDER_COMMAND_FRAGMENTS;

const RESPONDER_PROMPT_FRAGMENTS: Readonly<Record<string, string>> = {
  persona: `Eres "CreaMype", una estratega de marca peruana que conversa en español neutro latinoamericano, tuteando, cálido y profesional. Hablas con micro y pequeñas empresarias peruanas (MYPEs) que están creando su marca paso a paso.`,
  systemHeading: `Estado actual del orquestador (autoritativo, no lo cuestiones):`,
  progressHeading: `Progreso de campos (solo estados, sin valores):`,
  noopDecision: `kind=noop\nDecisión: no hay nada nuevo que comunicar.\nAcción obligatoria: en UNA sola frase corta, invita al usuario con una pregunta abierta a contarte sobre su negocio.`,
  requestFieldsDecision: `kind={{kind}}\nDecisión: pedir {{fieldCountDescription}} al usuario.\nAgente: {{agentId}}\nCampos a preguntar:\n{{fieldLines}}\n{{actionLine}}\nPROHIBIDO mencionar otros agentes o saltar al siguiente paso.`,
  requestFieldsSingleAction: `Acción obligatoria: pídele al usuario ÚNICAMENTE este campo. UNA sola pregunta natural en español.`,
  requestFieldsMultiAction: `Acción obligatoria: pídele al usuario AMBOS campos en UNA sola oración natural en español (por ejemplo "¿cómo se llama tu negocio y qué estilo quieres para el logo?"). NO los enumeres como una lista.`,
  confirmFieldDecision: `{{kind}}\nDecisión: confirmar un valor de baja confianza con el usuario.\nAgente: {{agentId}}\nCampo: {{fieldName}}\nValor pendiente: "{{pendingValue}}"\nRazón: {{reason}}\nAcción obligatoria: parafrasea el valor pendiente y haz UNA sola pregunta cerrada (sí/no) tipo "¿Es correcto?" o "¿Confirmas?".`,
  requestSelectionDecision: `{{kind}}\nDecisión: pedir al usuario que elija una alternativa.\nAgente: {{agentId}}\nCantidad de candidatos: {{count}}\nAcción obligatoria: invita al usuario a elegir una opción del panel lateral. NO listes los IDs ni inventes nombres.`,
  announceDispatchDecision: `{{kind}}\nDecisión: confirmar que el agente "{{agentId}}" empezó su trabajo.\nAcción obligatoria: confirma en UNA cláusula breve que el agente empezó (por ejemplo "ya estoy generando tu logo,"). PROHIBIDO usar "estoy trabajando", "estamos trabajando", "dame un momento", "dame un momentito", "ya casi", "un segundo", "en breve", "enseguida". PROHIBIDO usar saludos.`,
  announceAllCompleteDecision: `{{kind}}\nDecisión: el flujo de este paso está completo.\nAcción obligatoria: en UNA sola frase, indica que terminó este paso e invita al siguiente. NO recapitules valores.`,
  announceCompletionTextDecision: `{{kind}}\nDecisión: presentar las opciones que produjo el agente "{{agentId}}".\nOpciones a presentar (literal, en este orden):\n{{numberedOptions}}\nAcción obligatoria: lista estas opciones EXACTAMENTE como aparecen, numeradas de 1 a {{count}}, y pídele al usuario que elija una. PROHIBIDO inventar opciones adicionales, modificar el texto, o agregar comentarios sobre cada opción.`,
  announceCompletionVisualDecision: `{{kind}}\nDecisión: anunciar que el agente "{{agentId}}" terminó. El resultado ya está en el panel lateral.\nAcción obligatoria: en UNA sola frase, confirma que el resultado está en el panel lateral e invita al usuario a revisarlo: si le gusta, puede tocar el botón Aprobar; si quiere cambios, el botón Iterar. PROHIBIDO describir el contenido visual.`,
  announceCompletionEmptyDecision: `{{kind}}\nDecisión: anunciar que el agente "{{agentId}}" terminó.\nAcción obligatoria: en UNA sola frase, indica que terminó este paso e invita al siguiente.`,
  guardrails: [
    `Reglas para tu respuesta (estrictas, sin excepciones):`,
    `- Responde SIEMPRE en español, en máximo 2 oraciones.`,
    `- Usa español neutro latinoamericano y trata al usuario de "tú". NUNCA uses voseo ("vos", "querés", "tenés", "contame") aunque el usuario lo use, ni variantes de España ("vosotros", "vale").`,
    `- Tu respuesta DEBE corresponder exactamente a las decisiones indicadas arriba, en el orden listado. NO improvises temas adicionales.`,
    `- NO uses saludos. NUNCA escribas "Hola", "¡Hola!", "Buenas", "Qué tal", "Hey", ni similares. La conversación ya empezó.`,
    `- NO uses muletillas de espera. NUNCA escribas "estoy trabajando", "estamos trabajando", "dame un momentito", "dame un momento", "ya casi", "un segundo", "en breve", "enseguida".`,
    `- NO emitas llamadas a funciones, JSON, ni código.`,
    `- NO inventes información que no esté en el bloque "Decisión" o el "Progreso de campos".`,
    `- NO menciones nombres, productos, ni valores específicos del usuario salvo que la decisión actual los incluya explícitamente (por ejemplo "Valor pendiente" en confirm_field, u "Opciones a presentar" en announce_completion).`,
    `- Mantén un tono cálido pero directo.`,
  ].join('\n'),
  ...RESPONDER_COMMAND_FRAGMENTS,
  dispatchRequestGuardrail: `- Cuando combines un anuncio de despacho con una pregunta, escribe UNA sola respuesta de hasta 2 oraciones que primero confirme el despacho en una cláusula breve y luego pivotee a la pregunta del siguiente agente. Ejemplo de pivote: "Ya estoy generando tu logo. Para el slogan, ¿cómo describirías el tono que buscas?".`,
};

export function createCurrentAdapterBehaviorSnapshot(
  fields: ReadonlyArray<AdapterFieldBehavior> = [],
): AdapterBehaviorSnapshot {
  const stableFields = fields
    .map((field) => ({ ...field, agents: [...field.agents].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    schemaVersion: 'adapter-behavior.v1',
    extractor: {
      // v5 (KAN-26): the field list adds the brief catalog's brand/product fields
      // (logo-agent optional fields). Template unchanged; real eval pending.
      promptVersion: 'extractor.v5',
      promptTemplate: EXTRACTOR_PROMPT_TEMPLATE,
      rendererVersion: 'extractor.renderer.v1',
      parserVersion: 'extractor.parser.v1',
      temperature: 0,
      maxTokens: 512,
      toolName: 'submit_extracted_fields',
      toolDescription: 'Submit the fields you grounded from the user message. Pass null for fields not expressed or implied.',
      toolChoice: { type: 'function', function: { name: 'submit_extracted_fields' } },
      fieldSchemaTemplate: EXTRACTOR_FIELD_SCHEMA_TEMPLATE,
      fields: stableFields,
      // v2 (KAN-56): only a bare yes/no skips the LLM; compound replies are
      // extracted and combined with the pending confirmation.
      fastPathVersion: 'extractor.confirm-fast-path.v2',
      historyPolicyVersion: 'none',
    },
    responder: {
      // v6 (KAN-28): offer_generation, button guidance guardrail, Aprobar/Iterar
      // invitation on visual completion. Real eval pending owner confirmation.
      promptVersion: 'responder.chat-step1.v6',
      promptTemplate: RESPONDER_PROMPT_TEMPLATE,
      rendererVersion: 'responder.renderer.v1',
      parserVersion: 'responder.text.v1',
      temperature: 0.7,
      maxTokens: 1800,
      historyLimit: 10,
      historyPolicyVersion: 'responder.recent-messages.v1',
      promptFragments: RESPONDER_PROMPT_FRAGMENTS,
    },
  };
}

export function assertSupportedAdapterBehavior(
  behavior: AdapterBehaviorSnapshot,
  purpose: 'extractor' | 'responder',
): void {
  if (behavior.schemaVersion !== 'adapter-behavior.v1') {
    throw new Error(`Unsupported adapter behavior schema: ${String(behavior.schemaVersion)}`);
  }
  if (purpose === 'extractor') {
    const supplied = behavior.extractor;
    const current = createCurrentAdapterBehaviorSnapshot().extractor;
    if (
      supplied.rendererVersion !== current.rendererVersion ||
      supplied.parserVersion !== current.parserVersion ||
      supplied.fastPathVersion !== current.fastPathVersion ||
      supplied.historyPolicyVersion !== 'none'
    ) {
      throw new Error('Unsupported frozen extractor adapter behavior version.');
    }
    if (!validGenerationSettings(supplied.temperature, supplied.maxTokens)) {
      throw new Error('Frozen extractor generation settings are invalid.');
    }
    if (
      supplied.toolChoice.function.name !== supplied.toolName ||
      !supplied.promptTemplate.includes('{{toolName}}') ||
      !supplied.promptTemplate.includes('{{fieldLines}}') ||
      !supplied.promptTemplate.includes('español neutro latinoamericano') ||
      !supplied.promptTemplate.includes('trata al usuario de tú') ||
      !supplied.promptTemplate.includes('nunca uses voseo')
    ) {
      throw new Error('Frozen extractor adapter behavior is internally inconsistent.');
    }
  } else {
    const supplied = behavior.responder;
    const current = createCurrentAdapterBehaviorSnapshot().responder;
    if (
      supplied.rendererVersion !== current.rendererVersion ||
      supplied.parserVersion !== current.parserVersion ||
      supplied.historyPolicyVersion !== current.historyPolicyVersion
    ) {
      throw new Error('Unsupported frozen responder adapter behavior version.');
    }
    if (
      !validGenerationSettings(supplied.temperature, supplied.maxTokens) ||
      !Number.isSafeInteger(supplied.historyLimit) ||
      supplied.historyLimit < 0
    ) {
      throw new Error('Frozen responder settings are invalid.');
    }
    if (
      !supplied.promptTemplate.includes('{{persona}}') ||
      !supplied.promptTemplate.includes('{{stateHeading}}') ||
      !supplied.promptTemplate.includes('{{decisionsBlock}}') ||
      !supplied.promptTemplate.includes('{{progressBlock}}') ||
      !supplied.promptTemplate.includes('{{guardrails}}')
    ) {
      throw new Error('Frozen responder adapter behavior is internally inconsistent.');
    }
    if (
      typeof supplied.promptFragments.persona !== 'string' ||
      typeof supplied.promptFragments.systemHeading !== 'string' ||
      typeof supplied.promptFragments.progressHeading !== 'string' ||
      typeof supplied.promptFragments.noopDecision !== 'string' ||
      typeof supplied.promptFragments.requestFieldsDecision !== 'string' ||
      typeof supplied.promptFragments.requestFieldsSingleAction !== 'string' ||
      typeof supplied.promptFragments.requestFieldsMultiAction !== 'string' ||
      typeof supplied.promptFragments.confirmFieldDecision !== 'string' ||
      typeof supplied.promptFragments.requestSelectionDecision !== 'string' ||
      typeof supplied.promptFragments.announceDispatchDecision !== 'string' ||
      typeof supplied.promptFragments.announceAllCompleteDecision !== 'string' ||
      typeof supplied.promptFragments.announceCompletionTextDecision !== 'string' ||
      typeof supplied.promptFragments.announceCompletionVisualDecision !== 'string' ||
      typeof supplied.promptFragments.announceCompletionEmptyDecision !== 'string' ||
      typeof supplied.promptFragments.dispatchRequestGuardrail !== 'string' ||
      typeof supplied.promptFragments.guardrails !== 'string' ||
      !supplied.promptFragments.guardrails.includes('español neutro latinoamericano') ||
      !supplied.promptFragments.guardrails.includes('trata al usuario de "tú"') ||
      !supplied.promptFragments.guardrails.includes('NUNCA uses voseo') ||
      !supplied.promptFragments.guardrails.includes('"vosotros"')
    ) {
      throw new Error('Frozen responder behavior must retain the neutral Spanish and tuteo guardrails.');
    }
  }
}

export function assertResolvedModelPurpose(
  model: ResolvedModel,
  purpose: 'extractor' | 'responder',
): void {
  if (model.purpose !== purpose || !model.modelId || !model.client || !model.provider) {
    throw new Error(`Frozen execution model is not a valid ${purpose} model.`);
  }
}

function validGenerationSettings(temperature: number, maxTokens: number): boolean {
  return Number.isFinite(temperature) && temperature >= 0 &&
    Number.isSafeInteger(maxTokens) && maxTokens > 0;
}
