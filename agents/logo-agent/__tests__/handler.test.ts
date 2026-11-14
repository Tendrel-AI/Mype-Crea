/**
 * Unit tests for the logo-agent handler. Inject a fake IAgentLlm (the v4+ art director) and a fake
 * IImageGenerator via setters so we never call a real model. Verify:
 *   - v4: the image prompt is the English formula from the director slots + the exact upper-cased name
 *   - pinned v1-v3 (frozen prompt without a schema) render the legacy template with no LLM call
 *   - returned A2ATaskResult is completed with one image artifact
 *   - artifact metadata includes provider, model, prompt, purpose
 *   - the frozen v2 template renders per line (empty lines dropped, multi-field lines joined)
 *   - the tagline line only shows when existing_tagline is present; «Iterar» notes are appended
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INPUT_FIELDS, LOGO_LEGACY_TEMPLATE, LOGO_SLOTS, LOGO_PROMPT_VERSION, LOGO_SYSTEM_PROMPT, LOGO_TOOL, buildLogoMessages, handler, parseImageChange, previousSlotsOf, renderLogoFormula, renderLogoPrompt } from '../handler';
import { InMemoryObjectStorage } from '../../../src/services/storage/memory-storage';
import { resetObjectStorage, setObjectStorage } from '../../../src/services/storage';
import { MAX_LOGO_REFERENCES } from '../../../src/logo/refs';
import { getFrozenPrompt } from '../../../src/services/prompts';
import { resetAgentLlm, setAgentLlm, type AgentCompletionRequest } from '../../../src/services/llm/agent-completion';
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

const SLOTS = {
  format_style: 'Bold block-stamp flat vector',
  purpose_industry: 'sustainable direct-trade coffee',
  primary_entity: 'an anthropomorphic bear intertwined with a coffee branch',
  cultural_anchor: 'bold pre-Columbian block prints',
  structural_mechanics: 'thick, chunky shapes and high-contrast negative space cutouts',
  motifs: 'oversized coffee cherries',
  layout: 'dynamically asymmetric',
  typography: 'chunky serif lettering curving around the top',
  palette: 'deep forest green and warm cream',
  voice: 'earthy, ethical, and warm',
};

function fakeLlm(args: string = JSON.stringify(SLOTS)) {
  const calls: AgentCompletionRequest[] = [];
  setAgentLlm({
    complete: vi.fn(async (request: AgentCompletionRequest) => {
      calls.push(request);
      return {
        provider: 'openrouter' as const,
        model: 'fake/naming-1',
        completion: { id: 'c', choices: [{ message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 't', type: 'function' as const, function: { name: 'fill_logo_prompt', arguments: args } }] }, finish_reason: 'tool_calls' }] },
      };
    }),
  });
  return calls;
}

describe('logo-agent handler', () => {
  afterEach(() => {
    resetImageGenerator();
    resetAgentLlm();
  });

  it('v4: renders the formula from the director slots with the exact upper-cased name and records provenance', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    const llmCalls = fakeLlm();
    const reqs = { business_name: 'Café "Andino"', style_keywords: 'minimalista, andino', color_palette: 'tierra y verde' };

    const result = await handler(makeMessage(reqs), undefined);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const [artifact] = result.artifacts;
    expect(artifact.kind).toBe('image');
    expect(artifact.url).toBe('https://fake.cdn/logo.png');
    expect(captured[0].prompt).toBe(renderLogoFormula({ ...SLOTS, brand_name: "CAFÉ 'ANDINO'" }));
    expect(captured[0]).toMatchObject({ purpose: 'logo', usage: { tenantId: '22222222-2222-2222-2222-222222222222', agentTaskId: '11111111-1111-1111-1111-111111111111' } });
    expect(llmCalls[0]).toMatchObject({ purpose: 'naming', promptVersion: LOGO_PROMPT_VERSION, usage: { agentTaskId: '11111111-1111-1111-1111-111111111111' } });
    expect(artifact.metadata).toMatchObject({
      provider: 'fake-provider',
      model: 'fake-model/1',
      purpose: 'logo',
      promptVersion: LOGO_PROMPT_VERSION,
      agentCardVersion: '0.1.0',
      slots: { ...SLOTS, brand_name: "CAFÉ 'ANDINO'" },
      director: { provider: 'openrouter', model: 'fake/naming-1' },
      // KAN-35: the fields the prompt used, with the shared sha256 fingerprint.
      inputs: Object.fromEntries(Object.entries(reqs).map(([k, v]) => [k, { value: v, version: inputVersion(v) }])),
      // KAN-33: the classifier result is recorded as-is, even when it is not `passed`.
      safety: FAKE_SAFETY,
    });
  });

  it('v4: the director sees the filled brief and the quoted «Iterar» observations', () => {
    const [system, user] = buildLogoMessages({ business_name: 'Sol', logo_composition: 'A criterio del diseñador' }, { observations: ['más "azul"', ' '] });
    expect(system).toEqual({ role: 'system', content: LOGO_SYSTEM_PROMPT });
    expect(user.content).toContain('- Nombre exacto: "Sol"');
    expect(user.content).toContain('- Composición preferida: "A criterio del diseñador"');
    expect(user.content).toContain('Ajustes pedidos sobre la versión anterior: "más \'azul\'".');
  });

  it('v4: unusable tool arguments fail the task with invalid_output and never reach the image generator', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    fakeLlm('not json');
    const result = await handler(makeMessage({ business_name: 'Sol' }), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'invalid_output' } });
    expect(captured).toHaveLength(0);
  });

  it('a conversation pinned to logo-agent.v3 renders the legacy template and makes no LLM call', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    const llmCalls = fakeLlm();
    const v3 = getFrozenPrompt('logo-agent', 'logo-agent.v3')!;

    const result = await handler({ ...makeMessage({ business_name: 'Café Andino', style_keywords: 'minimalista, andino', color_palette: 'tierra y verde' }), prompt: v3 }, undefined);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(llmCalls).toHaveLength(0);
    expect(captured[0].prompt).toBe(renderLogoPrompt(LOGO_LEGACY_TEMPLATE, { business_name: 'Café Andino', style_keywords: 'minimalista, andino', color_palette: 'tierra y verde' }));
    expect(result.artifacts[0].metadata).toMatchObject({ promptVersion: 'logo-agent.v3', purpose: 'logo' });
    expect(result.artifacts[0].metadata).not.toHaveProperty('slots');
  });

  it.each([
    ['content_policy', new TaskError('content_policy', 'blocked by safety filter')],
    ['config_missing', new TaskError('config_missing', 'FAL_KEY is not set')],
    ['timeout', new TaskError('timeout', 'request timed out')],
    ['handler_threw', new Error('unexpected')],
  ] as const)('returns a failed result with kind %s when image generation fails (KAN-58)', async (kind, err) => {
    setImageGenerator({ generate: vi.fn(async () => { throw err; }) });
    fakeLlm();

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

describe('frozen logo prompts', () => {
  it('v6 frozen text and tool are the working director prompt and tool', () => {
    const v6 = getFrozenPrompt('logo-agent', 'logo-agent.v6')!;
    expect(v6.text).toBe(LOGO_SYSTEM_PROMPT);
    expect(v6.schema).toEqual(JSON.parse(JSON.stringify(LOGO_TOOL)));
    expect(LOGO_PROMPT_VERSION).toBe('logo-agent.v6');
  });

  it('pinned v4 keeps the same ten slot keys, so its director output still parses', () => {
    const v4 = getFrozenPrompt('logo-agent', 'logo-agent.v4')!;
    expect((v4.schema as typeof LOGO_TOOL).function.parameters.required).toEqual([...LOGO_SLOTS]);
  });

  it('renders the owner\'s «Mar Ancestral» prompt from its variables (D60)', () => {
    expect(renderLogoFormula({
      brand_name: 'MAR ANCESTRAL',
      format_style: 'Bold, monolithic block-stamp vector',
      purpose_industry: 'an artisan coastal seafood brand',
      primary_entity: 'a bipedal, anthropomorphic fisherman figure holding a large, stylized fish, seamlessly morphing into churning ocean waves',
      cultural_anchor: 'ancient coastal petroglyphs and vintage maritime linocut prints',
      structural_mechanics: 'thick, undulating organic shapes and broad, high-contrast white-space cutouts',
      motifs: 'bold, cascading wave crests and the silhouette of a traditional fishing net woven into the figure',
      layout: 'dynamically asymmetric, heavily weighted on the left with the surging waves while the figure reaches toward the right',
      typography: 'a heavy, hand-carved, blocky typeface anchored at the bottom',
      palette: 'a solid, deep navy blue and off-white',
      voice: 'rugged, handcrafted, and premium maritime',
    })).toBe('Bold, monolithic block-stamp vector logo for an artisan coastal seafood brand called "MAR ANCESTRAL". Features a bipedal, anthropomorphic fisherman figure holding a large, stylized fish, seamlessly morphing into churning ocean waves as the primary entity. Grounded in the visual language of ancient coastal petroglyphs and vintage maritime linocut prints, the design relies entirely on thick, undulating organic shapes and broad, high-contrast white-space cutouts to create the forms, strictly avoiding fine lines, tiny patterns, or shading. It integrates exactly two scalable motifs: bold, cascading wave crests and the silhouette of a traditional fishing net woven into the figure. The layout is dynamically asymmetric, heavily weighted on the left with the surging waves while the figure reaches toward the right, with "MAR ANCESTRAL" set in a heavy, hand-carved, blocky typeface anchored at the bottom. The palette is restricted to a solid, deep navy blue and off-white, prioritizing a rugged, handcrafted, and premium maritime identity with massive visual weight and scalability over generic modern minimalism.');
  });

  it.each(['logo-agent.v4', 'logo-agent.v5'])('%s stays frozen without the iteration field', (version) => {
    const pinned = getFrozenPrompt('logo-agent', version)!;
    expect(JSON.stringify(pinned.schema)).not.toContain('image_change');
    expect(pinned.text).not.toContain('image_change');
  });
});

describe('logo-agent v6: «Iterar» with context and reference images (D61/D62)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const dataUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  const PREVIOUS_BYTES = new Uint8Array([...PNG, 9]);
  const previous = {
    deliverableId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    storageKey: 'tenants/t/prev.png',
    url: null,
    metadata: { prompt: 'previous formula prompt', slots: { ...SLOTS, brand_name: 'CAFÉ ANDINO' } },
  };
  const ref = (n: number) => ({ fileId: `ref-${n}`, storageKey: `refs/${n}.png`, contentType: 'image/png', originalName: `ref-${n}.png` });
  let storage: InMemoryObjectStorage;
  const iterate = (reqs: Record<string, unknown>, overrides: Partial<A2AMessage> = {}): A2AMessage => ({
    ...makeMessage({ business_name: 'Café Andino', ...reqs }),
    iteration: { parentTaskId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' as never, observations: ['más "verde"'], previous },
    ...overrides,
  });

  beforeEach(async () => {
    storage = new InMemoryObjectStorage();
    setObjectStorage(storage);
    await storage.putObject(previous.storageKey, PREVIOUS_BYTES, 'image/png');
    for (let n = 1; n <= 5; n += 1) await storage.putObject(`refs/${n}.png`, new Uint8Array([...PNG, n]), 'image/png');
  });
  afterEach(() => {
    resetImageGenerator();
    resetAgentLlm();
    resetObjectStorage();
  });

  it('adjust: the director sees the previous slots, prompt and observations; the previous image goes first, then the references', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    const llmCalls = fakeLlm(JSON.stringify({ ...SLOTS, image_change: 'adjust' }));

    const result = await handler(iterate({ logo_references: [ref(1), ref(2)] }), undefined);

    expect(result.status).toBe('completed');
    const user = llmCalls[0].request.messages[1].content as string;
    expect(user).toContain(`- palette: "${SLOTS.palette}"`);
    expect(user).toContain('Prompt de la versión anterior: "previous formula prompt"');
    expect(user).toContain('Ajustes pedidos sobre la versión anterior: "más \'verde\'".');
    expect(user).toContain('El usuario subió 2 imágenes de referencia');
    expect(captured[0].referenceUrls).toEqual([dataUrl(PREVIOUS_BYTES), dataUrl(new Uint8Array([...PNG, 1])), dataUrl(new Uint8Array([...PNG, 2]))]);
    if (result.status === 'completed') expect(result.artifacts[0].metadata).toMatchObject({ imageMode: 'adjust', referenceCount: 2 });
  });

  it('redo: the previous image is not sent; only the owner references are', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    fakeLlm(JSON.stringify({ ...SLOTS, image_change: 'redo' }));

    const result = await handler(iterate({ logo_references: [ref(1)] }), undefined);

    expect(captured[0].referenceUrls).toEqual([dataUrl(new Uint8Array([...PNG, 1]))]);
    if (result.status === 'completed') expect(result.artifacts[0].metadata).toMatchObject({ imageMode: 'redo', referenceCount: 1 });
  });

  it('redo without references is plain text-to-image', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    fakeLlm(JSON.stringify({ ...SLOTS, image_change: 'redo' }));
    await handler(iterate({}), undefined);
    expect(captured[0]).not.toHaveProperty('referenceUrls');
  });

  it('references are capped at three and total never exceeds the provider limit', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    fakeLlm(JSON.stringify({ ...SLOTS, image_change: 'adjust' }));
    await handler(iterate({ logo_references: [1, 2, 3, 4, 5].map(ref) }), undefined);
    expect(captured[0].referenceUrls).toHaveLength(1 + MAX_LOGO_REFERENCES);
  });

  it('generate (no previous version) sends the references to edit-image and tells the director', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    const llmCalls = fakeLlm();
    const result = await handler(makeMessage({ business_name: 'Café Andino', logo_references: [ref(3)] }), undefined);
    expect(captured[0].referenceUrls).toEqual([dataUrl(new Uint8Array([...PNG, 3]))]);
    expect(llmCalls[0].request.messages[1].content).toContain('El usuario subió 1 imagen de referencia');
    expect(llmCalls[0].request.messages[1].content).not.toContain('versión anterior (');
    if (result.status === 'completed') expect(result.artifacts[0].metadata).toMatchObject({ imageMode: 'generate', referenceCount: 1 });
  });

  it('adjust falls back to redo when the previous image is gone', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    fakeLlm(JSON.stringify({ ...SLOTS, image_change: 'adjust' }));
    const result = await handler(iterate({}, { iteration: { parentTaskId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' as never, previous: { ...previous, storageKey: 'missing.png' } } }), undefined);
    expect(captured[0]).not.toHaveProperty('referenceUrls');
    if (result.status === 'completed') expect(result.artifacts[0].metadata).toMatchObject({ imageMode: 'redo' });
  });

  it('a missing reference is skipped, never fails the logo', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    fakeLlm();
    const result = await handler(makeMessage({ business_name: 'Café', logo_references: [{ ...ref(9), storageKey: 'nope.png' }] }), undefined);
    expect(result.status).toBe('completed');
    expect(captured[0]).not.toHaveProperty('referenceUrls');
  });

  it('a conversation pinned to v4 ignores the previous version and the references (behavior unchanged)', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));
    const llmCalls = fakeLlm();
    const v4 = getFrozenPrompt('logo-agent', 'logo-agent.v4')!;

    const result = await handler({ ...iterate({ logo_references: [ref(1)] }), prompt: v4 }, undefined);

    expect(result.status).toBe('completed');
    expect(captured[0]).not.toHaveProperty('referenceUrls');
    expect(llmCalls[0].request.messages).toEqual(buildLogoMessages({ business_name: 'Café Andino' }, { observations: ['más "verde"'] }, v4.text));
    const user = llmCalls[0].request.messages[1].content as string;
    expect(user).not.toContain('versión anterior (');
    expect(user).not.toContain('referencia');
    if (result.status === 'completed') expect(result.artifacts[0].metadata).not.toHaveProperty('imageMode');
  });

  it('previousSlotsOf needs all ten slots; parseImageChange only trusts an explicit adjust', () => {
    expect(previousSlotsOf({ slots: SLOTS })).toEqual(SLOTS);
    expect(previousSlotsOf({ slots: { ...SLOTS, voice: '' } })).toBeUndefined();
    expect(previousSlotsOf(null)).toBeUndefined();
    expect(parseImageChange('{"image_change":"adjust"}')).toBe('adjust');
    expect(parseImageChange('{"image_change":"other"}')).toBe('redo');
    expect(parseImageChange('nope')).toBe('redo');
  });
});

describe('frozen legacy logo template v3 (D22)', () => {
  const frozen = getFrozenPrompt('logo-agent', 'logo-agent.v3')!;
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

  it('is the frozen v3 text of the legacy template', () => {
    expect(frozen.text).toBe(LOGO_LEGACY_TEMPLATE);
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
