/**
 * AgentLlmService (KAN-31): the agent LLM call is reserved against the
 * owner's KAN-43 ledger before the provider runs, settled after, audited with
 * the `naming` purpose, and its failures become typed TaskErrors. Fake
 * provider and ledger only.
 */
import { describe, expect, it, vi } from 'vitest';

const record = vi.hoisted(() => vi.fn(async () => 'llm-call-id'));
vi.mock('../../../repos', () => ({
  repos: () => ({ llmCalls: { record } }),
  systemRepos: () => ({ llmCalls: { record } }),
}));

import { AgentLlmService, type AgentCompletionRequest } from '../agent-completion';
import { ProviderCallError } from '../provider-error';
import { FakeLLMProvider } from '../../../core/__tests__/_fixtures';
import type { UsageLedger } from '../../usage/gateway';
import type { ILLMProvider } from '../types';

const TENANT = '00000000-0000-0000-0000-000000000001';
const OWNER = '00000000-0000-0000-0000-000000000002';
const CONVERSATION = '00000000-0000-0000-0000-0000000000c1';
const TASK = '00000000-0000-0000-0000-0000000000a1';

const REQUEST: AgentCompletionRequest = {
  purpose: 'naming',
  promptVersion: 'name-agent.v1',
  request: { messages: [{ role: 'user', content: 'hola' }], max_tokens: 64 },
  usage: { tenantId: TENANT, agentTaskId: TASK },
};

function ledger(allowed: boolean) {
  return {
    reserve: vi.fn(async () => (allowed ? { allowed: true, reservationId: 'r-1' } : { allowed: false, reason: 'user_llm_hourly', reservationId: 'r-1' })),
    settle: vi.fn(async () => {}),
  } as unknown as UsageLedger & { reserve: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn> };
}

function service(provider: ILLMProvider, usage: UsageLedger) {
  return new AgentLlmService(() => provider, async () => ({ ledger: usage, conversationId: CONVERSATION, ownerUserId: OWNER }));
}

describe('AgentLlmService', () => {
  it('reserves, calls, settles and audits the call with the naming purpose', async () => {
    const provider = new FakeLLMProvider({ purpose: 'naming', modelId: 'fake/naming-1' }).scriptContent('ok');
    const usage = ledger(true);
    const result = await service(provider, usage).complete(REQUEST);

    expect(result).toMatchObject({ provider: 'openrouter', model: expect.any(String) });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(usage.reserve).toHaveBeenCalledWith(expect.objectContaining({ kind: 'llm', conversationId: CONVERSATION, agentTaskId: TASK }));
    expect(usage.settle).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'r-1', outcome: 'succeeded' }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'naming', promptVersion: 'name-agent.v1', agentTaskId: TASK, conversationId: CONVERSATION }));
  });

  it('a denied reservation is usage_limited and the provider is never called', async () => {
    const provider = new FakeLLMProvider({ purpose: 'naming' }).scriptToolCall('propose_business_names', '{}');
    await expect(service(provider, ledger(false)).complete(REQUEST)).rejects.toMatchObject({ name: 'TaskError', kind: 'usage_limited' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each([
    ['rate_limited', 'rate_limited'],
    ['ambiguous', 'timeout'],
    ['invalid_credentials', 'provider_rejected'],
  ] as const)('a %s provider failure becomes %s and the reservation settles as failed', async (category, kind) => {
    const provider = new FakeLLMProvider({ purpose: 'naming' });
    provider.create.mockRejectedValueOnce(new ProviderCallError(category));
    const usage = ledger(true);
    await expect(service(provider, usage).complete(REQUEST)).rejects.toMatchObject({ kind });
    expect(usage.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });

  it('a provider that cannot resolve the purpose is config_missing', async () => {
    const provider = { resolve: () => { throw new Error('no key'); } } as unknown as ILLMProvider;
    await expect(service(provider, ledger(true)).complete(REQUEST)).rejects.toMatchObject({ kind: 'config_missing' });
  });
});
