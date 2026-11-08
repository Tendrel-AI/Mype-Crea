/**
 * Eval -> prompt ledger hook. setup.ts mocks `llmCalls.record` to `captureCall`, so every model call
 * made by the adapter under test lands here; `recordEvalCase` turns them into eval Runs + Scores.
 * The LangSmith upload is the `langsmith/vitest` reporter, not a ledger mirror.
 * No Samples on purpose: outputs are already in LangSmith and `Sample.ref` must never hold content.
 * Judge calls bypass withLlmLogging, so they are never captured (and never get the adapter's scores).
 */
import { randomUUID } from 'node:crypto';
import type { PromptLedger, Run } from '../../src/lib/prompt-ledger';
import { createDeveloperLedger, registerCodePrompts } from '../../src/services/prompt-ledger';

interface CapturedCall {
  purpose?: string;
  model?: string;
  provider?: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  at: string;
}
interface Handle { ledger: PromptLedger; close(): Promise<void> }

const experimentId = `eval:${new Date().toISOString()}`;
let captured: CapturedCall[] = [];
let handle: Promise<Handle | null> | undefined;
let warned = false;

export const captureCall = (row: Omit<CapturedCall, 'at'>) => void captured.push({ ...row, at: new Date().toISOString() });
export const beginEvalCase = () => void (captured = []);

/** Tests only: inject a ledger, or pass undefined to reset module state. */
export function setLedgerForTests(ledger?: PromptLedger) {
  handle = ledger && Promise.resolve({ ledger, close: async () => {} });
  warned = false;
  captured = [];
}

function open(): Promise<Handle | null> {
  handle ??= (async () => {
    if (!process.env.DATABASE_URL || process.env.PROMPT_LEDGER === 'off') {
      console.info('[evals] prompt ledger is off (no DATABASE_URL or PROMPT_LEDGER=off)');
      return null;
    }
    const h = createDeveloperLedger();
    await registerCodePrompts(h.ledger);
    return h;
  })();
  return handle;
}

export async function recordEvalCase(args: {
  key: string;
  /** Prompt version constant of the adapter under test (used only for the failed-run fallback). */
  version: string;
  caseId: string;
  feedback: ReadonlyArray<{ key: string; score: number }>;
  error?: unknown;
}) {
  const calls = captured;
  captured = [];
  try {
    const h = await open();
    if (!h) return;
    const scores = args.feedback.map((f) => ({ metric: f.key, value: f.score }));
    const base = { kind: 'eval', outcome: 'succeeded', experimentId } as const;
    const runs: Run[] = calls.map((c) => ({
      ...base,
      id: randomUUID(),
      key: c.purpose ?? args.key,
      version: c.promptVersion ?? args.version,
      model: c.model ?? 'unknown',
      provider: c.provider,
      startedAt: c.at,
      latencyMs: c.latencyMs,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
    }));
    if (args.error !== undefined && !runs.some((r) => r.key === args.key)) {
      runs.push({ ...base, id: randomUUID(), key: args.key, version: args.version, model: 'unknown', startedAt: new Date().toISOString(), outcome: 'failed', errorCategory: 'eval_error' });
    }
    for (const run of runs) await h.ledger.recordRun(run, run.key === args.key ? scores : []);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`[evals] prompt ledger write failed (case ${args.caseId}); further failures are silent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function closeEvalLedger() {
  const h = await handle?.catch(() => null);
  await h?.close();
}
