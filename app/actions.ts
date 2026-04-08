'use server';

import { GoogleGenAI } from '@google/genai';

export async function generateImageAction(prompt: string, referenceImageBase64?: string) {
  const apiKey = process.env.CUSTOM_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("La clave CUSTOM_GEMINI_API_KEY no está configurada en los secretos de la aplicación. Por favor, añádela en el menú de Settings de AI Studio.");
  }

  const ai = new GoogleGenAI({ apiKey });
  
  let parts: any[] = [{ text: prompt }];
  
  if (referenceImageBase64) {
    const matches = referenceImageBase64.match(/^data:(.+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      parts.unshift({
        inlineData: {
          mimeType: matches[1],
          data: matches[2]
        }
      });
    }
  }

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: { parts },
    config: {
      imageConfig: { aspectRatio: "1:1", imageSize: "512px" }
    }
  });
  
  const base64 = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
  if (!base64) throw new Error("No se pudo generar la imagen");
  return `data:image/png;base64,${base64}`;
}
