/**
 * Unit tests for the logo-agent handler. Inject a fake IImageGenerator via
 * setImageGenerator so we never call fal. Verify:
 *   - returned A2ATaskResult is completed with one image artifact
 *   - artifact metadata includes provider, model, prompt, purpose
 *   - prompt construction includes business_name + style_keywords + color_palette when present
 *   - color_palette is omitted from the prompt when not supplied
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildLogoPrompt, handler } from '../handler';
import { resetImageGenerator, setImageGenerator } from '../../../src/services/image';
import type { ImageRequest, ImageResult } from '../../../src/services/image';
import type { A2AMessage } from '../../../src/core/agent-types';

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

function fakeGenerator(captured: ImageRequest[]) {
  return {
    generate: vi.fn(async (req: ImageRequest): Promise<ImageResult> => {
      captured.push(req);
      return {
        url: 'https://fake.cdn/logo.png',
        providerId: 'fake-provider',
        modelId: 'fake-model/1',
        latencyMs: 42,
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
    });
    expect(artifact.metadata?.prompt).toContain('Café Andino');
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

  it('omits the palette sentence from the prompt when color_palette is not supplied', () => {
    const withPalette = buildLogoPrompt({
      business_name: 'X',
      style_keywords: 'y',
      color_palette: 'azul',
    });
    const withoutPalette = buildLogoPrompt({
      business_name: 'X',
      style_keywords: 'y',
    });
    expect(withPalette).toContain('Paleta de colores: azul');
    expect(withoutPalette).not.toContain('Paleta de colores');
  });
});
