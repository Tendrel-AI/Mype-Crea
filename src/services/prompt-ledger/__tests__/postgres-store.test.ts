import { describe, expect, it, vi } from 'vitest';
import { DuplicateRunError } from '../../../lib/prompt-ledger';
import { PostgresLedgerStore, type TransactionalQueryable } from '../postgres-store';

function fakeDb(failOn?: { code: string }) {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      calls.push(text.trim().split(/\s/)[0]);
      if (failOn && text.includes('INSERT INTO prompt_ledger_eval_runs')) throw Object.assign(new Error('dup'), failOn);
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const db = { query: vi.fn(async () => ({ rows: [] })), connect: async () => client } as unknown as TransactionalQueryable;
  return { db, client, calls };
}

const run = { id: 'r1', key: 'k', version: 'v1', kind: 'eval' as const, model: 'm', startedAt: '2026-01-01T00:00:00.000Z', outcome: 'succeeded' as const };

describe('PostgresLedgerStore', () => {
  it('commits a run in one transaction', async () => {
    const { db, calls, client } = fakeDb();
    await new PostgresLedgerStore(db).insertRun(run, [{ runId: 'r1', metric: 'a', value: 1 }], []);
    expect(calls).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
    expect(client.release).toHaveBeenCalled();
  });

  it('maps a unique violation to DuplicateRunError and rolls back', async () => {
    const { db, calls, client } = fakeDb({ code: '23505' });
    await expect(new PostgresLedgerStore(db).insertRun(run, [], [])).rejects.toBeInstanceOf(DuplicateRunError);
    expect(calls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('destroys the client when ROLLBACK itself fails', async () => {
    const { db, client } = fakeDb({ code: '57P01' });
    const rollbackErr = new Error('connection lost');
    const base = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (text: string) => {
      if (text === 'ROLLBACK') throw rollbackErr;
      return base(text);
    });
    await expect(new PostgresLedgerStore(db).insertRun(run, [], [])).rejects.toThrow('dup');
    expect(client.release).toHaveBeenCalledWith(rollbackErr);
  });

  it('refuses to write production runs', async () => {
    await expect(new PostgresLedgerStore(fakeDb().db).insertRun({ ...run, kind: 'production' }, [], [])).rejects.toThrow(/llm_calls/);
  });

  it('maps app.prompt_ledger_feedback rows to Feedback and refuses to write it', async () => {
    const { db } = fakeDb();
    const query = vi.fn(async () => ({ rows: [{ subject_id: 'd1', rater_hash: 'abc', value: 'up', updated_at: new Date('2026-01-01T00:00:00Z') }] }));
    const store = new PostgresLedgerStore({ ...db, query } as unknown as TransactionalQueryable);
    expect(await store.listFeedback('logo-agent', 'logo-agent.v1')).toEqual([
      { subjectId: 'd1', raterId: 'abc', key: 'logo-agent', version: 'logo-agent.v1', value: 'up', at: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('app.prompt_ledger_feedback'), ['logo-agent.v1']);
    await expect(store.upsertFeedback({} as never)).rejects.toThrow(/only by the app/);
  });
});
