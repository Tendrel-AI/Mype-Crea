import { describe, expect, it } from 'vitest';
import { hashPromptContent } from '../../../lib/prompt-ledger';
import { planFreeze } from '../freeze';

const p = { key: 'logo-agent', version: 'logo-agent.v1', text: 'hello' };
const hash = hashPromptContent({ text: 'hello' });

describe('planFreeze', () => {
  it('writes a new version', () => {
    const [plan] = planFreeze([p], {}, 'T');
    expect(plan).toMatchObject({ action: 'write', file: { ...p, contentHash: hash, frozenAt: 'T' } });
  });
  it('skips an already frozen identical version', () => {
    expect(planFreeze([p], { 'logo-agent': { 'logo-agent.v1': hash } }, 'T')[0].action).toBe('already-frozen');
  });
  it('errors when a frozen version changed', () => {
    const [plan] = planFreeze([{ ...p, text: 'changed' }], { 'logo-agent': { 'logo-agent.v1': hash } }, 'T');
    expect(plan).toMatchObject({ action: 'error', message: expect.stringContaining('bump the version constant in agents/logo-agent/handler.ts') });
  });
});
