'use server';

import OpenAI from 'openai';

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

export async function chatAction(params: {
  messages: ChatMessage[];
  step: number;
  assets: BrandAssets;
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('La clave OPENROUTER_API_KEY no está configurada.');
  }

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  const systemMessage = {
    role: 'system' as const,
    content: getSystemInstruction(params.step, params.assets),
  };

  const completion = await client.chat.completions.create({
    model: 'google/gemini-2.5-pro',
    messages: [systemMessage, ...params.messages] as any,
    tools: TOOLS,
    temperature: 0.7,
    max_tokens: 8192,
  });

  const choice = completion.choices[0];
  return {
    content: choice.message.content ?? '',
    toolCalls: (choice.message.tool_calls ?? []) as Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>,
  };
}
