import { IMAGE_PRICE_USD, llmCostUsd } from '../../src/services/usage/policy';
import type { RunResult } from './simulate';

/** Production per-call tokens of one agent generation (one naming call each; the logo also makes one image). */
const AGENT_CALL_TOKENS: Readonly<Record<string, { in: number; out: number }>> = {
  'name-agent': { in: 982, out: 359 },
  'tagline-agent': { in: 1016, out: 404 },
  'logo-agent': { in: 3462, out: 517 },
};

const sum = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: ReadonlyArray<number>) => (xs.length === 0 ? 0 : sum(xs) / xs.length);

/** USD of one run: Extractor + Responder at their recorded tokens, plus the fixed cost of every agent dispatch. */
export function runCostUsd(run: RunResult, namingModel: string): number {
  const llm = sum(run.calls.map((c) => c.cost_usd ?? llmCostUsd(c.model, { prompt_tokens: c.input_tokens, completion_tokens: c.output_tokens, cached_tokens: c.cached_tokens, cache_write_tokens: c.cache_write_tokens }) ?? 0));
  const agents = sum(run.dispatches.map((d) => {
    const t = AGENT_CALL_TOKENS[d.agentId];
    const naming = t ? llmCostUsd(namingModel, { prompt_tokens: t.in, completion_tokens: t.out }) ?? 0 : 0;
    return naming + (d.agentId === 'logo-agent' ? IMAGE_PRICE_USD : 0);
  }));
  return llm + agents;
}

/** OpenRouter list prices ($/MTok in, out; 2026-11-14) for user models the product price table does not carry. */
const SIM_USER_PRICES: Readonly<Record<string, readonly [number, number]>> = {
  'minimax/minimax-m3.1-flash': [0.15, 0.6],
};

/** Simulated-user cost, never part of the product cost. */
export function userCostUsd(run: RunResult, userModel: string): number {
  const price = SIM_USER_PRICES[userModel];
  return sum(run.userCalls.map((c) => price
    ? (c.input_tokens * price[0] + c.output_tokens * price[1]) / 1_000_000
    : llmCostUsd(userModel, { prompt_tokens: c.input_tokens, completion_tokens: c.output_tokens }) ?? 0));
}

/** First / middle / last responder input tokens of a run (growth with the conversation). */
function responderGrowth(run: RunResult): [number, number, number] | null {
  const r = run.calls.filter((c) => c.purpose === 'responder').map((c) => c.input_tokens);
  return r.length === 0 ? null : [r[0], r[Math.floor(r.length / 2)], r[r.length - 1]];
}

const f = (n: number, d = 0) => n.toFixed(d);
const usd = (n: number) => `$${n.toFixed(4)}`;

/** Plain-text summary of one persona's runs. */
export function formatSummary(persona: string, runs: ReadonlyArray<RunResult>, namingModel: string, userModel: string): string {
  const n = Math.max(runs.length, 1);
  const turns = runs.map((r) => r.chatTurns);
  const per = (purpose: 'extractor' | 'responder') => {
    const calls = runs.flatMap((r) => r.calls.filter((c) => c.purpose === purpose));
    return `${calls.length} calls (${f(calls.length / n, 1)}/run), avg in/out ${f(avg(calls.map((c) => c.input_tokens)))}/${f(avg(calls.map((c) => c.output_tokens)))}, avg cached ${f(avg(calls.map((c) => c.cached_tokens ?? 0)))}`;
  };
  const growth = runs.map(responderGrowth).filter((g): g is [number, number, number] => g !== null);
  const outcomes: Record<string, number> = {};
  for (const r of runs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const dispatches = runs.flatMap((r) => r.dispatches);
  const costs = runs.map((r) => runCostUsd(r, namingModel));
  return [
    `== ${persona} (${runs.length} runs) ==`,
    `chat turns avg/min/max: ${f(avg(turns), 1)} / ${Math.min(...turns)} / ${Math.max(...turns)}`,
    `extractor: ${per('extractor')}`,
    `responder: ${per('responder')}`,
    `responder input tokens first/middle/last (avg): ${growth.length ? [0, 1, 2].map((i) => f(avg(growth.map((g) => g[i])))).join(' / ') : 'n/a'}`,
    `dispatches/run: ${f(dispatches.length / n, 1)} (iterations ${f(dispatches.filter((d) => d.iteration).length / n, 1)}/run)`,
    `outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `product USD/run avg/min/max: ${usd(avg(costs))} / ${usd(Math.min(...costs))} / ${usd(Math.max(...costs))} (naming priced with ${namingModel})`,
    `simulated user (NOT product cost) USD/run avg: ${usd(avg(runs.map((r) => userCostUsd(r, userModel))))} (${userModel})`,
  ].join('\n');
}
