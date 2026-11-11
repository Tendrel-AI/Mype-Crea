/**
 * Unit tests for the logo-agent handler. Inject a fake IImageGenerator via
 * setImageGenerator so we never call fal. Verify:
 *   - returned A2ATaskResult is completed with one image artifact
 *   - artifact metadata includes provider, model, prompt, purpose
 *   - the frozen v2 template renders per line (empty lines dropped, multi-field lines joined)
 *   - the tagline line only shows when existing_tagline is present; «Iterar» notes are appended
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INPUT_FIELDS, LOGO_PROMPT_TEMPLATE, LOGO_PROMPT_VERSION, handler, renderLogoPrompt } from '../handler';
import { getFrozenPrompt } from '../../../src/services/prompts';
import { resetImageGenerator, setImageGenerator } from '../../../src/services/image';
import type { ImageRequest, ImageResult } from '../../../src/services/image';
import type { A2AMessage } from '../../../src/core/agent-types';
import { TaskError } from '../../../src/core/task-errors';
import { inputVersion } from '../../../src/core/deliverable-inputs';

function makeMessage(reqs: Record<string, unknown>): A2AMessage {
  return {
    taskId: '11111111-1111-1111-1111-111111111111' as A2AMessage['taskId'],
    tenantId: '22222222-2222-2222-2222-222222222222',
    agentId: 'logo-agent',
    agentCardVersion: '0.1.0',
    requirements: reqs,
    createdAt: new Date().toISOString(),
  };
}

const FAKE_SAFETY = {
  verdict: 'rejected',
  category: 'sexual_content',
  classifier: 'fal-safety-checker',
  model: 'fake-model/1',
  policyVersion: 'logo-safety.v1',
  checkedAt: '2026-11-03T00:00:00.000Z',
} as const;

function fakeGenerator(captured: ImageRequest[]) {
  return {
    generate: vi.fn(async (req: ImageRequest): Promise<ImageResult> => {
      captured.push(req);
      return {
        url: 'https://fake.cdn/logo.png',
        providerId: 'fake-provider',
        modelId: 'fake-model/1',
        latencyMs: 42,
        safety: FAKE_SAFETY,
      };
    }),
  };
}

describe('logo-agent handler', () => {
  afterEach(() => {
    resetImageGenerator();
  });

  it('returns one image artifact with provider + model + prompt + purpose metadata', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));

    const result = await handler(
      makeMessage({
        business_name: 'Café Andino',
        style_keywords: 'minimalista, andino',
        color_palette: 'tierra y verde',
      }),
      undefined,
    );

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts).toHaveLength(1);
    const [artifact] = result.artifacts;
    expect(artifact.kind).toBe('image');
    expect(artifact.url).toBe('https://fake.cdn/logo.png');
    expect(artifact.metadata).toMatchObject({
      provider: 'fake-provider',
      model: 'fake-model/1',
      purpose: 'logo',
      // KAN-29: the provenance the deliverables panel shows.
      promptVersion: LOGO_PROMPT_VERSION,
      agentCardVersion: '0.1.0',
    });
    expect(artifact.metadata?.prompt).toContain('Café Andino');
    expect(artifact.metadata?.prompt).toContain('tierra y verde');
    // KAN-35: the fields the prompt used, with the shared sha256 fingerprint.
    expect(artifact.metadata?.inputs).toEqual({
      business_name: { value: 'Café Andino', version: inputVersion('Café Andino') },
      style_keywords: { value: 'minimalista, andino', version: inputVersion('minimalista, andino') },
      color_palette: { value: 'tierra y verde', version: inputVersion('tierra y verde') },
    });
    // KAN-33: the classifier result is recorded as-is, even when it is not `passed`.
    expect(artifact.metadata?.safety).toEqual(FAKE_SAFETY);
    expect(inputVersion('Café Andino')).toMatch(/^sha256:[0-9a-f]{64}$/);
    // KAN-43: the image is charged through the usage gate to this task's tenant.
    expect(captured[0].usage).toEqual({ tenantId: '22222222-2222-2222-2222-222222222222', agentTaskId: '11111111-1111-1111-1111-111111111111' });
  });

  it('passes a prompt to the generator that includes business_name, style_keywords, and color_palette', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));

    await handler(
      makeMessage({
        business_name: 'Café Andino',
        style_keywords: 'minimalista, andino',
        color_palette: 'tierra y verde',
      }),
      undefined,
    );

    expect(captured).toHaveLength(1);
    const sent = captured[0];
    expect(sent.purpose).toBe('logo');
    expect(sent.prompt).toContain('Café Andino');
    expect(sent.prompt).toContain('minimalista, andino');
    expect(sent.prompt).toContain('tierra y verde');
  });

  it.each([
    ['content_policy', new TaskError('content_policy', 'blocked by safety filter')],
    ['config_missing', new TaskError('config_missing', 'FAL_KEY is not set')],
    ['timeout', new TaskError('timeout', 'request timed out')],
    ['handler_threw', new Error('unexpected')],
  ] as const)('returns a failed result with kind %s when image generation fails (KAN-58)', async (kind, err) => {
    setImageGenerator({ generate: vi.fn(async () => { throw err; }) });

    const result = await handler(
      makeMessage({ business_name: 'Café Andino', style_keywords: 'minimalista' }),
      undefined,
    );

    expect(result).toMatchObject({
      status: 'failed',
      taskId: '11111111-1111-1111-1111-111111111111',
      error: { kind, message: err.message },
    });
  });
});

describe('frozen logo template v2 (D22)', () => {
  const frozen = getFrozenPrompt('logo-agent', LOGO_PROMPT_VERSION)!;
  const sparse = { business_name: 'Café "Andino". Sur' };
  const full = {
    business_name: 'Café Andino', existing_tagline: 'Sabor de altura', business_category: 'Café', market_proposition: 'Café de origen',
    logo_goal: 'Verse profesional', target_audience: 'Jóvenes', differentiator: 'Tostado local', personality: 'Cálida',
    logo_avoid: 'Sin Sin preferencia', competitors: 'Marca X', brand_story: 'Abuela cafetalera', visual_references: 'Ref A',
    logo_composition: 'Nombre y símbolo', logo_shapes: 'Curvas', style_keywords: 'minimalista', visual_behavior: 'Sobrio',
    logo_typography: 'Mayúsculas', color_palette: '#112233', color_description: 'tierra', logo_keep: 'La taza',
    language_references: 'Quechua', location: 'Cusco', logo_applications: 'Empaque', logo_production_limits: '2 cm',
    logo_restrictions: 'Sin rojo',
  };

  it('is the frozen text of the working template', () => {
    expect(frozen.text).toBe(LOGO_PROMPT_TEMPLATE);
  });

  it('INPUT_FIELDS covers every placeholder of the template', () => {
    const used = [...frozen.text.matchAll(/\{\{([\w|]+)\}\}/g)].flatMap(([, group]) => group.split('|'));
    expect([...new Set(used)].sort()).toEqual([...INPUT_FIELDS].sort());
  });

  it('drops every brief line whose fields are empty and keeps static lines', () => {
    const out = renderLogoPrompt(frozen.text, sparse);
    expect(out).toContain('- Nombre exacto: Café "Andino". Sur');
    expect(out).not.toContain('Eslogan y reglas de uso');
    expect(out).not.toContain('Competidores y riesgos');
    expect(out).not.toContain('{{');
    expect(out).toContain('DECISIONES DE DISEÑO');
    expect(out).not.toMatch(/REVISIÓN ANTES|pide una aclaración|\{versiones\}|\{criterios\}/);
  });

  it('joins several fields on one line and drops it only when all are empty', () => {
    expect(renderLogoPrompt(frozen.text, { ...sparse, market_proposition: 'Café de origen' }))
      .toContain('- Productos, servicios y alcance futuro: Café de origen\n');
    const out = renderLogoPrompt(frozen.text, { ...sparse, logo_shapes: 'Curvas', visual_behavior: 'Sobrio' });
    expect(out).toContain('- Características de formas y trazos: Curvas; Sobrio\n');
    expect(out).not.toContain('Colores requeridos');
  });

  it('shows the tagline line only when existing_tagline is present', () => {
    expect(renderLogoPrompt(frozen.text, full)).toContain('- Eslogan y reglas de uso: Sabor de altura');
    expect(renderLogoPrompt(frozen.text, { ...full, existing_tagline: '  ' })).not.toContain('Eslogan y reglas de uso');
  });

  it('renders a full brief with every field once', () => {
    const out = renderLogoPrompt(frozen.text, full);
    for (const value of Object.values(full)) expect(out.split(value).length - 1).toBeGreaterThanOrEqual(1);
    expect(out).toContain('- Productos, servicios y alcance futuro: Café; Café de origen');
    expect(out).toContain('- Contexto cultural e idiomas: Quechua; Cusco');
    expect(out.split('Café de origen').length - 1).toBe(1);
  });

  it('appends Iterar observations as their own quoted, single-line section (KAN-28)', () => {
    const out = renderLogoPrompt(frozen.text, sparse, { observations: ['Hazlo más "azul"\n y moderno', '   '] });
    expect(out.endsWith('AJUSTES SOBRE LA VERSIÓN ANTERIOR\nAjustes pedidos sobre la versión anterior: "Hazlo más \'azul\' y moderno".')).toBe(true);
    expect(renderLogoPrompt(frozen.text, sparse, { observations: [] })).not.toContain('AJUSTES');
  });

  it('keeps rendering a pinned single-line v1 template', () => {
    const v1 = getFrozenPrompt('logo-agent', 'logo-agent.v1')!;
    expect(renderLogoPrompt(v1.text, { business_name: 'X', style_keywords: 'y' }, { observations: ['más grande'] })).toBe(
      'Diseña un logo profesional para el negocio "X". Estilo: y. Ajustes pedidos sobre la versión anterior: "más grande". Limpio, vectorizado, alta resolución, sin texto adicional.',
    );
  });

  it('records only the filled fields the prompt read, and the attached prompt wins', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    try {
      const message = { ...makeMessage({ business_name: 'Café', logo_goal: 'Verse pro', product_name: 'ignorado' }), prompt: { version: 'logo-agent.v0', text: 'Logo para "{{business_name}}". Cierre.' } };
      const result = await handler(message, undefined);
      expect(captured[0].prompt).toBe('Logo para "Café". Cierre.');
      expect(result.status === 'completed' && Object.keys(result.artifacts[0].metadata?.inputs as object)).toEqual(['business_name', 'logo_goal']);
      expect(result.status === 'completed' && result.artifacts[0].metadata?.promptVersion).toBe('logo-agent.v0');
    } finally {
      resetImageGenerator();
    }
  });
});
