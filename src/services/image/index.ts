/**
 * Module-level singleton for the configured IImageGenerator. Mirrors the
 * pattern in src/services/llm/index.ts: lazy construction inside
 * `getImageGenerator()` so importing this module during build/SSR doesn't
 * explode when env vars aren't set, and `setImageGenerator()` /
 * `resetImageGenerator()` for tests that need to swap in a fake.
 */
import { FalImageProvider } from './fal-provider';
import { ImageGeneratorService } from './generator';
import type { IImageGenerator } from './types';

export type {
  IImageGenerator,
  IImageProvider,
  ImagePurpose,
  ImageRequest,
  ImageResult,
} from './types';
export { ImageGeneratorService } from './generator';
export { FalImageProvider } from './fal-provider';

let generator: IImageGenerator | undefined;

export function getImageGenerator(): IImageGenerator {
  if (generator) return generator;
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error(
      'FAL_KEY is not set. The image generator requires a fal.ai API key.',
    );
  }
  generator = new ImageGeneratorService(new FalImageProvider(apiKey));
  return generator;
}

/** Test hook: swap in a fake or clear the cached singleton. */
export function setImageGenerator(g: IImageGenerator | undefined): void {
  generator = g;
}

/** Test hook: drop the cached singleton so the next `getImageGenerator()` rebuilds. */
export function resetImageGenerator(): void {
  generator = undefined;
}
