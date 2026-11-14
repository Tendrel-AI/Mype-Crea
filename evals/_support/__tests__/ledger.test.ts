import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryLedgerStore, PromptLedger } from '../../../src/lib/prompt-ledger';
import { beginEvalCase, captureCall, recordEvalCase, setLedgerForTests } from '../ledger';

async function makeLedger() {
  const store = new InMemoryLedgerStore();
  const ledger = new PromptLedger({ store });
  await ledger.registerVersion({ key: 'extractor', version: 'extractor.v5', text: 'x' });
  await ledger.registerVersion({ key: 'naming', version: 'naming.v1', text: 'n' });
  return { ledger, store };
}
const call = (purpose: string, promptVersion: string) => ({ purpose, promptVersion, model: 'm', provider: 'p', inputTokens: 3, outputTokens: 2, latencyMs: 10 });
const args = { key: 'extractor', version: 'extractor.v5', caseId: 'c1', feedback: [{ key: 'f1', score: 0.5 }] };

beforeEach(() => beginEvalCase());
afterEach(() => {
  setLedgerForTests();
  vi.restoreAllMocks();
  delete process.env.PROMPT_LEDGER;
});

describe('recordEvalCase', () => {
  it('writes one run per captured call and scores only the adapter run', async () => {
    const { ledger } = await makeLedger();
    setLedgerForTests(ledger);
    const spy = vi.spyOn(ledger, 'recordRun');
    captureCall(call('extractor', 'extractor.v5'));
    captureCall(call('naming', 'naming.v1'));
    await recordEvalCase(args);
    expect(spy).toHaveBeenCalledTimes(2);
    const [adapter, other] = spy.mock.calls;
    expect(adapter[0]).toMatchObject({ key: 'extractor', kind: 'eval', outcome: 'succeeded', version: 'extractor.v5' });
    expect(adapter[1]).toEqual([{ metric: 'f1', value: 0.5 }]);
    expect(adapter[2]).toEqual([{ ref: 'eval-case:c1', mediaType: 'application/x-eval-case' }]);
    expect(other[2]).toEqual([]);
    expect(other[0].key).toBe('naming');
    expect(other[1]).toEqual([]);
    expect(adapter[0].experimentId).toBe(other[0].experimentId);
  });

  it('writes a failed run when the adapter threw before any call was captured', async () => {
    const { ledger } = await makeLedger();
    setLedgerForTests(ledger);
    const spy = vi.spyOn(ledger, 'recordRun');
    await recordEvalCase({ ...args, error: new Error('boom') });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ key: 'extractor', version: 'extractor.v5', outcome: 'failed', errorCategory: 'eval_error' });
  });

  it('does not throw and warns once when the ledger write fails', async () => {
    const { ledger } = await makeLedger();
    setLedgerForTests(ledger);
    vi.spyOn(ledger, 'recordRun').mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 2; i++) {
      captureCall(call('extractor', 'extractor.v5'));
      await expect(recordEvalCase(args)).resolves.toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('db down');
  });

  it('is a no-op when PROMPT_LEDGER=off', async () => {
    process.env.PROMPT_LEDGER = 'off';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    captureCall(call('extractor', 'extractor.v5'));
    await expect(recordEvalCase(args)).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('ledger is off'));
  });
});
