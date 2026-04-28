'use server';

import { randomUUID } from 'node:crypto';
import { resolveIdentity } from '../../src/auth/resolve-identity';
import { ChatInputAdapter } from '../../src/adapters/chat-input-adapter';
import { ChatOutputAdapter } from '../../src/adapters/chat-output-adapter';
import type { PlannerDecision, TaskId } from '../../src/core/contracts';
import { buildDefaultRegistry } from '../../src/core/orchestrator/bootstrap-registry';
import {
  InProcessDecisionNotifier,
  OrchestratorCoreImpl,
} from '../../src/core/orchestrator/orchestrator-core';
import { PostgresConversationStore } from '../../src/core/orchestrator/postgres-store';
import { repos } from '../../src/repos';
import { getProvider } from '../../src/services/llm';
import { withLlmLogging } from '../../src/services/llm-logger';
import { loggerFor } from '../../src/services/logger';
import { LocalAdapter } from '../../src/transport/local-adapter';

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: any[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface BrandAssets {
  name: string;
  profile: string;
  logoUrl: string;
  labelUrl: string;
  landingPage: string;
  marketingPlan: string;
}

/**
 * Bumped whenever the system prompt content changes. Persisted on every
 * llm_calls row so we can correlate behavior changes to prompt revisions.
 */
const SYSTEM_PROMPT_VERSION = '2026-04-27.v1';

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'finalize_name',
      description: 'Guarda el nombre del negocio y el perfil, avanzando al Paso 2 (Logo). Usa esta herramienta SOLO cuando el usuario haya aprobado explícitamente un nombre.',
      parameters: {
        type: 'object',
        properties: {
          business_name: { type: 'string' },
          business_profile: { type: 'string', description: 'Resumen de industria, audiencia, valores' },
        },
        required: ['business_name', 'business_profile'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_logo',
      description: 'Genera un logo basado en un prompt detallado en inglés, avanzando al Paso 3 (Etiqueta). Usa esta herramienta SOLO cuando el usuario haya aprobado un estilo de logo.',
      parameters: {
        type: 'object',
        properties: {
          image_prompt: { type: 'string', description: 'Prompt altamente detallado en inglés para generar el logo (estilo, colores, tipografía, etc.)' },
        },
        required: ['image_prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_label',
      description: 'Genera una etiqueta de producto basada en un prompt detallado en inglés, avanzando al Paso 4 (Landing Page). Usa esta herramienta SOLO cuando el usuario haya aprobado el concepto de la etiqueta.',
      parameters: {
        type: 'object',
        properties: {
          image_prompt: { type: 'string', description: 'Prompt altamente detallado en inglés para generar la etiqueta del producto' },
        },
        required: ['image_prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'finalize_landing_page',
      description: 'Guarda el código HTML de la landing page con Tailwind CSS, avanzando al Paso 5 (Marketing). Usa esta herramienta para generar la web final.',
      parameters: {
        type: 'object',
        properties: {
          html_content: { type: 'string', description: 'Código HTML de la landing page usando clases de Tailwind CSS. IMPORTANTE: El diseño debe ser ultra-moderno (año 2026), premium y minimalista. Usa mucho espacio en blanco (py-24), tipografía grande y elegante (tracking-tight), bordes muy redondeados (rounded-3xl), efectos de cristal (backdrop-blur, bg-white/10), sombras suaves (shadow-2xl), y gradientes modernos. Evita diseños anticuados o genéricos. En el header/nav, usa el logo (LOGO_URL_PLACEHOLDER) en lugar de un icono de estrella o texto genérico. Puedes usar un icono de estrella para el favicon si quieres. Devuelve SOLO el contenido interior del <body> (nav, header, main, footer). NO incluyas las etiquetas <html>, <head>, <body> ni <!DOCTYPE html>. NO uses bloques de código markdown (```html).' },
        },
        required: ['html_content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'finalize_marketing',
      description: 'Guarda el plan de marketing en formato Markdown, completando el flujo.',
      parameters: {
        type: 'object',
        properties: {
          markdown_content: { type: 'string', description: 'Plan de marketing detallado en Markdown (redes sociales, email, contenido, publicidad pagada)' },
        },
        required: ['markdown_content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_logo',
      description: 'Edita el logo actual usando un nuevo prompt en inglés. Usa esta herramienta cuando el usuario pida cambios en el logo generado.',
      parameters: {
        type: 'object',
        properties: {
          image_prompt: { type: 'string', description: 'Prompt detallado en inglés para modificar el logo actual.' },
        },
        required: ['image_prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_label',
      description: 'Edita la etiqueta actual usando un nuevo prompt en inglés. Usa esta herramienta cuando el usuario pida cambios en la etiqueta generada.',
      parameters: {
        type: 'object',
        properties: {
          image_prompt: { type: 'string', description: 'Prompt detallado en inglés para modificar la etiqueta actual.' },
        },
        required: ['image_prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_landing_page',
      description: 'Edita el código HTML de la landing page. Usa esta herramienta cuando el usuario pida cambios en la página web.',
      parameters: {
        type: 'object',
        properties: {
          html_content: { type: 'string', description: 'El nuevo código HTML de la landing page con los cambios aplicados. IMPORTANTE: Mantén un diseño ultra-moderno (año 2026), premium y minimalista. Usa mucho espacio en blanco (py-24), tipografía grande y elegante (tracking-tight), bordes muy redondeados (rounded-3xl), efectos de cristal (backdrop-blur, bg-white/10), sombras suaves (shadow-2xl), y gradientes modernos. En el header/nav, usa el logo (LOGO_URL_PLACEHOLDER) en lugar de un icono de estrella o texto genérico. Puedes usar un icono de estrella para el favicon si quieres. Devuelve SOLO el contenido interior del <body> (nav, header, main, footer). NO incluyas las etiquetas <html>, <head>, <body> ni <!DOCTYPE html>. NO uses bloques de código markdown (```html).' },
        },
        required: ['html_content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_marketing_plan',
      description: 'Edita el plan de marketing en Markdown. Usa esta herramienta cuando el usuario pida cambios en la campaña o plan de marketing.',
      parameters: {
        type: 'object',
        properties: {
          markdown_content: { type: 'string', description: 'El nuevo plan de marketing completo en Markdown con los cambios aplicados.' },
        },
        required: ['markdown_content'],
      },
    },
  },
];

function getSystemInstruction(currentStep: number, currentAssets: BrandAssets) {
  return `Eres 'CreaMype', un experto estratega de marca y diseñador. Tu objetivo es guiar al usuario a través de 5 pasos para crear su marca y lanzar su producto.

    Paso actual: ${currentStep}.
    Activos actuales: ${JSON.stringify(currentAssets)}.

    Reglas estrictas:
    - Habla siempre en español.
    - Sé proactivo, creativo y profesional.
    - NO uses una herramienta de avance (finalize_name, generate_logo, etc.) hasta que el usuario haya confirmado su elección para ese paso.
    - Si el usuario pide cambios en algo ya generado (logo, etiqueta, web, marketing), DEBES usar las herramientas de edición correspondientes (edit_logo, edit_label, edit_landing_page, edit_marketing_plan).
    - Tienes el contexto completo de los activos actuales en 'Activos actuales'. Úsalos para mantener la coherencia.

    Guía por pasos:
    - Paso 1 (Nombre): Pregunta sobre la industria, valores, audiencia. Sugiere 3-5 nombres con justificación. Cuando el usuario elija uno, usa 'finalize_name'.
    - Paso 2 (Logo): Pregunta sobre el estilo del logo (minimalista, ilustrativo, tipográfico, etc.). Cuando el usuario elija, usa 'generate_logo' con un prompt en inglés muy detallado.
    - Paso 3 (Etiqueta): Pregunta sobre los detalles del producto para la etiqueta. Usa 'generate_label' con un prompt en inglés muy detallado. El sistema usará el logo generado previamente como referencia visual para mantener la coherencia.
    - Paso 4 (Landing Page): Escribe el copy persuasivo y diseña una landing page en HTML con Tailwind CSS. El diseño DEBE ser de vanguardia (año 2026): estilo premium, con mucho espacio en blanco (py-24), tipografías enormes y audaces (tracking-tight), bento grids, efectos glassmorphism (backdrop-blur) y bordes muy redondeados (rounded-3xl). Evita diseños aburridos o genéricos de los 2010s. Usa 'finalize_landing_page'. MUY IMPORTANTE: Para mostrar el logo y la etiqueta en el HTML, usa exactamente los textos "LOGO_URL_PLACEHOLDER" y "LABEL_URL_PLACEHOLDER" en los atributos src de las etiquetas <img>. En el header/nav, usa el logo (LOGO_URL_PLACEHOLDER) en lugar de un icono de estrella o texto genérico. Puedes usar un icono de estrella para el favicon si quieres. El sistema los reemplazará automáticamente con las imágenes reales. Asegúrate de generar el HTML detallado pero SOLO el contenido del <body>.
    - Paso 5 (Marketing): Crea un plan de marketing multicanal en Markdown. Usa 'finalize_marketing'.

    Edición:
    - Si el usuario dice "cambia el color del logo a azul", usa 'edit_logo'.
    - Si el usuario dice "agrega una sección de testimonios a la web", usa 'edit_landing_page' y reescribe el HTML (SOLO el contenido del <body>).
    - Si el usuario dice "haz el plan de marketing más enfocado en TikTok", usa 'edit_marketing_plan'.`;
}

const log = loggerFor('controller.chat');

export async function chatAction(params: {
  conversationId: string;
  messages: ChatMessage[];
  step: number;
  assets: BrandAssets;
  /**
   * Most recent user-typed input. Set by the client only on the first
   * round-trip of a send (subsequent loop iterations re-call chatAction
   * to drive tool calls and must not re-persist the user message).
   */
  lastUserInput?: string;
}) {
  const { tenant, user } = await resolveIdentity();
  const child = log.child({
    tenantId: tenant.id,
    userId: user.id,
    conversationId: params.conversationId,
    step: params.step,
  });
  child.info('chatAction.start');

  const r = repos(tenant, user);

  // Ensure the conversations row exists so the FK on messages holds.
  await r.conversations.getOrCreate(params.conversationId, []);

  if (params.lastUserInput && params.lastUserInput.trim().length > 0) {
    await r.messages.insert({
      conversationId: params.conversationId,
      role: 'user',
      content: params.lastUserInput,
    });
  }

  const responder = getProvider().resolve('responder');

  const systemMessage = {
    role: 'system' as const,
    content: getSystemInstruction(params.step, params.assets),
  };

  const completion = await withLlmLogging(
    responder.client,
    {
      model: responder.modelId,
      messages: [systemMessage, ...params.messages] as any,
      tools: TOOLS,
      temperature: 0.7,
      max_tokens: 8192,
    },
    {
      tenant,
      user,
      conversationId: params.conversationId,
      promptVersion: SYSTEM_PROMPT_VERSION,
      modelRevision: responder.modelRevision,
    },
  );

  const choice = completion.choices[0];
  const content = choice.message.content ?? '';
  const toolCalls = (choice.message.tool_calls ?? []) as Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;

  // Persist the assistant turn iff it has user-visible content. Tool-call-only
  // turns are intentionally not persisted as messages — they're already
  // captured in the llm_calls audit row, and would clutter conversation reads.
  if (content && content.length > 0) {
    await r.messages.insert({
      conversationId: params.conversationId,
      role: 'assistant',
      content,
    });
  }

  child.info(
    { contentLength: content.length, toolCallsCount: toolCalls.length },
    'chatAction.complete',
  );

  return { content, toolCalls };
}

/**
 * Vertical slice of the 4-layer orchestrator on Paso 1 (business name).
 *
 * The user message is fed through:
 *   1. ChatInputAdapter  (Gemini Flash extractor → FieldDelta)
 *   2. OrchestratorCore  (deterministic merge → planner)
 *   3. LocalAdapter      (dispatches name-agent if requirements satisfied)
 *   4. ChatOutputAdapter (Gemini Pro renderer → Spanish text)
 *
 * Returns the PlannerDecision and a projection of name-agent's filled
 * fields so the UI can advance to Paso 2 on `announce_completion` without
 * having to query the snapshot itself. Pasos 2-5 stay on `chatAction`.
 */
export async function chatActionStep1(params: {
  conversationId: string;
  lastUserInput: string;
}): Promise<{
  content: string;
  decision: PlannerDecision;
  extractedAssets: { name?: string; profile?: string };
}> {
  const { tenant, user } = await resolveIdentity();
  const child = log.child({
    tenantId: tenant.id,
    userId: user.id,
    conversationId: params.conversationId,
    flow: 'step1',
  });
  child.info('chatActionStep1.start');

  const r = repos(tenant, user);

  // Ensure the conversations row exists (the FK on messages + agent_tasks
  // both depend on this).
  await r.conversations.getOrCreate(params.conversationId, []);

  if (params.lastUserInput && params.lastUserInput.trim().length > 0) {
    await r.messages.insert({
      conversationId: params.conversationId,
      role: 'user',
      content: params.lastUserInput,
    });
  }

  // ---- Build the orchestrator ------------------------------------------
  // Per-call construction is fine: durable state lives in Postgres, in-memory
  // bookkeeping is per-conversation.
  const registry = buildDefaultRegistry();
  const store = new PostgresConversationStore(registry.getFieldSchemas());
  let core: OrchestratorCoreImpl;
  const transport = new LocalAdapter(registry, (taskId, state) => {
    void core.onTaskSettled(taskId, state);
  });
  const notifier = new InProcessDecisionNotifier();
  const tasksRepo = r.agentTasks;
  core = new OrchestratorCoreImpl({
    store,
    registry,
    transport,
    notifier,
    newTaskId: () => randomUUID() as TaskId,
    agentTasksFor: () => tasksRepo,
  });

  await core.startConversation(params.conversationId, tenant.id, user.id);

  // ---- Layer 1: extract -------------------------------------------------
  const inputAdapter = new ChatInputAdapter(core, registry);
  const llmContext = {
    tenant,
    user,
    conversationId: params.conversationId,
    promptVersion: 'extractor.v1',
  };

  // The extractor needs to know if the previous turn asked the user to
  // confirm a value, so it can take the affirmation fast-path.
  const priorDecision = await core.getNextDecision(params.conversationId);

  const delta = await inputAdapter.extract({
    conversationId: params.conversationId,
    userMessage: params.lastUserInput,
    activeAgentId: 'name-agent',
    priorDecision,
    llmContext,
  });

  // ---- Layer 2: apply (merge + maybe dispatch) --------------------------
  await core.applyDelta(delta);

  // ---- Drain dispatch deterministically ---------------------------------
  // LocalAdapter fires handlers via queueMicrotask; without waiting,
  // getNextDecision() would return `idle: awaiting_dispatch` instead of the
  // completion announcement.
  const postMergeSnapshot = await core.getSnapshot(params.conversationId);
  for (const [agentId, agentState] of Object.entries(postMergeSnapshot.agentStates)) {
    if (agentState.lastDispatchedTaskId) {
      child.info({ agentId, taskId: agentState.lastDispatchedTaskId }, 'awaiting settlement');
      await transport.waitForSettlement(agentState.lastDispatchedTaskId);
    }
  }

  // ---- Layer 3 boundary: ask the planner what to do next ---------------
  const decision = await core.getNextDecision(params.conversationId);

  // ---- Layer 4: render Spanish reply ------------------------------------
  const recent = await r.messages.listByConversation(params.conversationId, { limit: 20 });
  const snapshot = await core.getSnapshot(params.conversationId);
  const outputAdapter = new ChatOutputAdapter(registry);
  const { content } = await outputAdapter.render({
    decision,
    recentMessages: recent.map((m) => ({ role: m.role, content: m.content })),
    snapshot,
    llmContext,
  });

  // Persist the assistant turn so future renders carry tone continuity.
  if (content.length > 0) {
    await r.messages.insert({
      conversationId: params.conversationId,
      role: 'assistant',
      content,
    });
  }

  // Project name-agent's slots so the UI can mirror them into BrandAssets.
  const nameAgentState = snapshot.agentStates['name-agent'];
  const extractedAssets = {
    name: stringSlot(nameAgentState?.requiredFields?.business_name),
    profile: stringSlot(nameAgentState?.requiredFields?.business_profile),
  };

  child.info(
    {
      decisionKind: decision.kind,
      contentLength: content.length,
      hasName: Boolean(extractedAssets.name),
      hasProfile: Boolean(extractedAssets.profile),
    },
    'chatActionStep1.complete',
  );

  return { content, decision, extractedAssets };
}

function stringSlot(slot: { status: string; value?: unknown } | undefined): string | undefined {
  if (!slot || slot.status !== 'filled') return undefined;
  return typeof slot.value === 'string' ? slot.value : undefined;
}
