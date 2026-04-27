'use server';

import { fal } from '@fal-ai/client';

export async function generateImageAction(prompt: string, referenceImageDataUrl?: string) {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error('La clave FAL_KEY no está configurada. Obtén una en https://fal.ai/dashboard/keys');
  }

  fal.config({ credentials: apiKey });

  const isEdit = Boolean(referenceImageDataUrl);
  const endpoint = isEdit ? 'fal-ai/nano-banana-2/edit' : 'fal-ai/nano-banana-2';

  const input: Record<string, unknown> = { prompt };
  if (isEdit) {
    input.image_urls = [referenceImageDataUrl];
  }

  const result = await fal.subscribe(endpoint, { input });
  const url = (result.data as any)?.images?.[0]?.url;
  if (!url) throw new Error('No se pudo generar la imagen');
  return url as string;
}
