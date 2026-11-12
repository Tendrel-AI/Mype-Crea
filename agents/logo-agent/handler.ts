/**
 * Logo agent handler.
 *
 * Reads the logo brief (`INPUT_FIELDS`) from the dispatched A2AMessage's
 * requirements, renders the frozen Spanish template, and asks
 * the centralized image generator (src/services/image) for a PNG URL. Returns
 * one image artifact. No DB writes, no R2 upload, no versioning — those are
 * downstream concerns left to a future PR.
 *
 * The handler depends on IImageGenerator, never on a specific provider, so
 * swapping fal for another vendor never touches this file.
 *
 * Logging: this handler runs inside the agent worker process (architecturally
 * separate from the orchestrator), so it owns its own logger scope. Every
 * step from prompt-build through generator return is logged with the
 * canonical `taskId` so the lifecycle is auditable end-to-end alongside the
 * worker's logs.
 *
 * Traceability (KAN-35): the artifact metadata records the brief fields the
 * prompt actually used (`inputs`: value plus `inputVersion` fingerprint), so
 * a later change to one of them marks this logo «Potencialmente
 * desactualizado». Fields the prompt does not read never do.
 *
 * Safety (KAN-33): the image service's classifier result is recorded as
 * `metadata.safety` (verdict + provenance). The handler does not judge it:
 * a non-passed logo is still returned, stored and auditable, and every
 * reader hides it and refuses its approval (src/core/deliverable-safety.ts).
 *
 * Failures: an image-generation error is returned as a failed A2ATaskResult
 * whose `error.kind` is the typed kind from the image service
 * (`content_policy`, `config_missing`, `rate_limited`, `timeout`, …), or
 * `handler_threw` when the error carries no kind (architecture §2.5).
 */
import type { AgentHandler } from '../../src/core/agent-types';
import type { SafetyRecord } from '../../src/core/deliverable-safety';
import { inputVersion } from '../../src/core/deliverable-inputs';
import { taskErrorFromThrown } from '../../src/core/task-errors';
import { getImageGenerator } from '../../src/services/image';
import { loggerFor } from '../../src/services/logger';
import { agentPrompt } from '../../src/services/prompts';

const log = loggerFor('agent.logo-agent');

/** Recorded on every logo (KAN-29 provenance). Bump it when `LOGO_PROMPT_TEMPLATE` wording changes. */
export const LOGO_PROMPT_VERSION = 'logo-agent.v3';

/**
 * The working logo prompt; `npm run prompt:freeze` writes it to `prompts/logo-agent/`. Placeholders:
 *   - `{{field}}`   the brief value of `field`.
 *   - `{{a|b|c}}`   the non-empty values of a, b, c joined with "; " (one line may combine fields).
 * Rendering is per line: a line is dropped when ALL its placeholders are empty (so an unanswered
 * optional field leaves no hole); lines without placeholders always stay. Each field appears on ONE line,
 * and every field used here must be listed in `INPUT_FIELDS`.
 */
export const LOGO_PROMPT_TEMPLATE = [
  'Actúa como diseñador de identidad visual. Diseña una propuesta de logo para la marca descrita en el brief.',
  '',
  'OBJETIVO',
  'Resuelve el problema de comunicación indicado por el cliente. Fundamenta las decisiones visuales en su negocio, público, referencias y aplicaciones. No sustituyas esos datos por interpretaciones genéricas de palabras como “bonito”, “moderno”, “premium” o “único”.',
  '',
  'BRIEF',
  '- Nombre exacto: {{business_name}}',
  '- Eslogan y reglas de uso: {{existing_tagline}}',
  '- Productos, servicios y alcance futuro: {{business_category|market_proposition}}',
  '- Problema que debe resolver el logo: {{logo_goal}}',
  '- Público y situaciones de contacto: {{target_audience}}',
  '- Posicionamiento y motivos de elección: {{differentiator}}',
  '- Asociaciones deseadas: {{personality}}',
  '- Interpretaciones que deben evitarse: {{logo_avoid}}',
  '- Competidores y riesgos de confusión: {{competitors}}',
  '- Historia e inspiración vinculadas a la marca: {{brand_story}}',
  '- Referencias y características que se valoran o rechazan: {{visual_references}}',
  '- Composición preferida o decisión delegada al diseñador: {{logo_composition}}',
  '- Características de formas y trazos: {{logo_shapes|style_keywords|visual_behavior}}',
  '- Preferencias y restricciones tipográficas: {{logo_typography}}',
  '- Colores requeridos, permitidos y excluidos: {{color_palette|color_description}}',
  '- Elementos existentes que deben conservarse: {{logo_keep}}',
  '- Contexto cultural e idiomas: {{language_references|location}}',
  '- Aplicaciones prioritarias: {{logo_applications}}',
  '- Tamaño mínimo y métodos de producción: {{logo_production_limits}}',
  '- Elementos obligatorios y prohibidos: {{logo_restrictions}}',
  '',
  'DECISIONES DE DISEÑO',
  '1. Prioriza los requisitos obligatorios y las aplicaciones principales. Si hay una contradicción, resuélvela a favor de ellos.',
  '2. Cuando una preferencia esté sin definir o indicada como «sin preferencia», «no aplica» o «A criterio del diseñador», elige una solución basada en el resto del brief. No inventes hechos sobre la marca.',
  '3. Elige un concepto visual central. No intentes representar todos los productos, historias o valores dentro de un solo símbolo.',
  '4. No reproduzcas símbolos, lettering ni composiciones de las marcas de referencia. Usa únicamente las características descritas como orientación.',
  '5. Evita los motivos identificados como repetidos en los competidores.',
  '',
  'EJECUCIÓN',
  '- Reproduce el nombre con la escritura exacta.',
  '- Si el brief incluye un eslogan, inclúyelo con la escritura exacta.',
  '- Si hay símbolo y nombre, establece una relación equilibrada entre sus tamaños, separación y alineación.',
  '- Cuida el espaciado entre letras y la lectura del nombre.',
  '- Mantén contornos definidos, curvas continuas, uniones controladas y espacios interiores suficientemente abiertos.',
  '- Ajusta el detalle y el grosor de los trazos al tamaño mínimo indicado.',
  '- Usa el color según el brief y conserva una estructura reconocible cuando el conjunto se reproduzca en una sola tinta.',
  '- No añadas adornos que no contribuyan al concepto o a la lectura.',
  '',
  'PRESENTACIÓN',
  'Presenta una sola propuesta de logo completo, centrada, sin recortes y con espacio libre alrededor. Usa un fondo uniforme que permita evaluar sus formas y colores.',
  '',
  'No incluyas mockups, objetos, escenarios, textos explicativos ni marcas de agua. No añadas sombras, volumen, texturas o degradados, salvo que estén expresamente justificados en el brief.',
].join('\n');

/** Brief fields the template reads (the `{{...}}` names above). */
export const INPUT_FIELDS = [
  'business_name', 'existing_tagline', 'business_category', 'market_proposition', 'logo_goal', 'target_audience',
  'differentiator', 'personality', 'logo_avoid', 'competitors', 'brand_story', 'visual_references', 'logo_composition',
  'logo_shapes', 'style_keywords', 'visual_behavior', 'logo_typography', 'color_palette', 'color_description',
  'logo_keep', 'language_references', 'location', 'logo_applications', 'logo_production_limits', 'logo_restrictions',
] as const;

type LogoRequirements = Readonly<Partial<Record<string, string>>>;

const PLACEHOLDER = /\{\{([\w|]+)\}\}/g;

/**
 * Render a frozen logo template (D22) with the brief, plus the «Iterar» observations (KAN-28 / KAN-65 R2)
 * as their own closing section: quoted, flattened guidance, never parsed (untrusted text).
 * Syntax: see `LOGO_PROMPT_TEMPLATE`. A single-line template (frozen `logo-agent.v1`, pinned by older
 * conversations) keeps its sentence rule: split on ". ", drop sentences with an empty `{{field}}`, note before the last one.
 */
export function renderLogoPrompt(
  template: string,
  reqs: LogoRequirements,
  refinement?: { readonly observations?: ReadonlyArray<string> },
): string {
  const notes = (refinement?.observations ?? []).map(flattenObservation).filter((note) => note.length > 0);
  const note = `Ajustes pedidos sobre la versión anterior: ${notes.map((n) => `"${n}"`).join('; ')}.`;
  if (!template.includes('\n')) {
    const sentences = template.split(/(?<=\.) /)
      .filter((sentence) => [...sentence.matchAll(PLACEHOLDER)].every(([, name]) => reqs[name]))
      .map((sentence) => sentence.replace(PLACEHOLDER, (_, name: string) => reqs[name] ?? ''));
    if (notes.length > 0) sentences.splice(-1, 0, note);
    return sentences.join(' ');
  }
  const lines = template.split('\n').flatMap((line) => {
    const names = [...line.matchAll(PLACEHOLDER)];
    if (names.length === 0) return [line];
    const rendered = line.replace(PLACEHOLDER, (_, group: string) =>
      group.split('|').map((name) => reqs[name]?.trim()).filter(Boolean).join('; '));
    return names.some(([, group]) => group.split('|').some((name) => reqs[name]?.trim())) ? [rendered] : [];
  });
  if (notes.length > 0) lines.push('', 'AJUSTES SOBRE LA VERSIÓN ANTERIOR', note);
  return lines.join('\n');
}

/** One line, no double quotes, so a note cannot break out of its quotes. */
function flattenObservation(observation: string): string {
  return observation.replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim();
}

/** `{ field: { value, version } }` for every filled field the prompt reads. */
export function usedInputs(requirements: Readonly<Record<string, unknown>>): Record<string, { value: string; version: string }> {
  return Object.fromEntries(
    INPUT_FIELDS.flatMap((name) => {
      const value = requirements[name];
      return typeof value === 'string' && value.trim().length > 0 ? [[name, { value, version: inputVersion(value) }]] : [];
    }),
  );
}

export const handler: AgentHandler<undefined> = async (message) => {
  const child = log.child({
    op: 'handle',
    taskId: message.taskId,
    tenantId: message.tenantId,
    agentId: message.agentId,
    agentCardVersion: message.agentCardVersion,
  });

  const reqs = message.requirements as unknown as LogoRequirements;
  child.info(
    {
      requirementKeys: Object.keys(message.requirements),
      hasBusinessName: Boolean(reqs.business_name),
    },
    'agent.logo.start',
  );

  const frozen = agentPrompt(message.prompt, 'logo-agent');
  const prompt = renderLogoPrompt(frozen.text, reqs, message.iteration);
  child.info({ promptLength: prompt.length }, 'agent.logo.prompt_built');

  const startedAt = Date.now();
  let url: string;
  let providerId: string;
  let modelId: string;
  let safety: SafetyRecord;
  try {
    const result = await getImageGenerator().generate({
      prompt,
      purpose: 'logo',
      usage: { tenantId: message.tenantId, agentTaskId: message.taskId },
    });
    url = result.url;
    providerId = result.providerId;
    modelId = result.modelId;
    safety = result.safety;
  } catch (err) {
    const error = taskErrorFromThrown(err);
    child.error(
      { err, errorKind: error.kind, durationMs: Date.now() - startedAt },
      'agent.logo.image_generation_failed',
    );
    return {
      status: 'failed',
      taskId: message.taskId,
      error,
      completedAt: new Date().toISOString(),
    };
  }

  child.info(
    {
      providerId,
      modelId,
      durationMs: Date.now() - startedAt,
      hasUrl: Boolean(url),
      safetyVerdict: safety.verdict,
    },
    'agent.logo.image_generated',
  );

  return {
    status: 'completed',
    taskId: message.taskId,
    artifacts: [
      {
        kind: 'image',
        url,
        metadata: {
          provider: providerId,
          model: modelId,
          prompt,
          purpose: 'logo',
          inputs: usedInputs(message.requirements),
          promptVersion: frozen.version,
          agentCardVersion: message.agentCardVersion,
          safety,
        },
      },
    ],
    completedAt: new Date().toISOString(),
  };
};
