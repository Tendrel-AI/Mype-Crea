/**
 * Simulated-user conversation runner. COSTS REAL TOKENS (Extractor, Responder and the simulated user).
 *
 *   npm run sim -- --persona hablador-confuso --runs 3 [--max-turns 40] [--out <dir>]
 *
 * Agents are stubbed; their cost is added in the report from fixed per-call numbers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

async function main(): Promise<void> {
  // Before the logger loads: keep the summary readable; override with LOG_LEVEL=info|debug for the full trace.
  process.env.LOG_LEVEL ??= 'warn';
  const { PERSONAS } = await import('./sim/personas');
  const { runConversation } = await import('./sim/simulate');
  const { createOpenRouterUserModel } = await import('./sim/user-model');
  const { formatSummary } = await import('./sim/report');
  const { getProvider } = await import('../src/services/llm');

  const { values } = parseArgs({
    options: {
      persona: { type: 'string' }, runs: { type: 'string', default: '1' },
      'max-turns': { type: 'string', default: '40' }, out: { type: 'string', default: 'sim-out' },
    },
  });
  const persona = PERSONAS[values.persona ?? ''];
  const runs = Number(values.runs);
  const maxTurns = Number(values['max-turns']);
  if (!persona || !Number.isInteger(runs) || runs < 1 || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error(`Usage: sim --persona <${Object.keys(PERSONAS).join('|')}> --runs N [--max-turns N] [--out dir]`);
  }
  const provider = getProvider();
  const userModel = createOpenRouterUserModel();
  const namingModel = provider.resolve('naming').modelId;
  const results = [];
  for (let i = 1; i <= runs; i += 1) {
    const result = await runConversation({ persona, userModel, provider, maxTurns });
    console.log(`run ${i}/${runs}: ${result.outcome} in ${result.chatTurns} turns`);
    results.push(result);
  }
  const out = values.out as string;
  mkdirSync(out, { recursive: true });
  const file = join(out, `${persona.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ persona: persona.id, userModel: userModel.model, namingModel, runs: results }, null, 2));
  console.log(`\n${formatSummary(persona.id, results, namingModel, userModel.model)}\n\nreport: ${file}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
