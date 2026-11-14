import OpenAI from 'openai';
import type { UserModel } from './simulate';

/** Simulated user on OpenRouter through the OpenAI SDK. Its tokens are reported apart from product cost. */
export function createOpenRouterUserModel(
  apiKey = process.env.OPENROUTER_API_KEY,
  model = process.env.SIM_USER_MODEL ?? 'minimax/minimax-m3.1-flash',
): UserModel & { readonly model: string } {
  if (!apiKey?.trim()) throw new Error('OPENROUTER_API_KEY is required for the simulated user.');
  const client = new OpenAI({ apiKey: apiKey.trim(), baseURL: 'https://openrouter.ai/api/v1' });
  return {
    model,
    async complete(system, user) {
      const started = Date.now();
      const res = await client.chat.completions.create({
        model,
        temperature: 0.8,
        max_tokens: 2000, // headroom for reasoning models; billed only for what is generated
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return {
        text: res.choices[0]?.message?.content ?? '',
        input_tokens: res.usage?.prompt_tokens ?? 0,
        output_tokens: res.usage?.completion_tokens ?? 0,
        latency_ms: Date.now() - started,
      };
    },
  };
}
