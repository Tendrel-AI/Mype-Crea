import { describe, expect, it, vi } from 'vitest';

// withLlmLogging persists through the repos factory; keep it off the database.
const recordSpy = vi.fn(async () => 'fake-llm-call-id');
vi.mock('../../../repos', () => ({
  repos: () => ({ llmCalls: { record: recordSpy } }),
  systemRepos: () => ({ llmCalls: { record: recordSpy } }),
}));

import type { ResolvedIdentity } from '../../../auth/resolve-identity';
import type { ChatCompletion, ChatRequest, ILLMProvider, ResolvedModel } from '../../llm/types';
import { ProviderCallError, type ProviderFailureCategory } from '../../llm/provider-error';
import { withLlmLogging } from '../../llm-logger';
import { createCurrentAdapterBehaviorSnapshot } from '../adapter-behavior';
import { AiConfigRuntime, assertExecutable, type AttemptWriter, type RuntimeRepositories } from '../execution';
import { freezeManifest } from '../manifest';
import { ProviderRegistry } from '../provider-registry';
import type { UsageLedger } from '../../usage/gateway';
import { llmCostUsd, type UsageDenialReason } from '../../usage/policy';

const identity = { tenant: { id: 'tenant-a' }, user: { id: 'user-a' }, tenantRole: 'member', workosUserId: 'user_abc', organizationId: 'org_abc', platformAdmin: false } as unknown as ResolvedIdentity;
const fields = { forced: ['forced-tool-call', 'json-schema'], ordinary: [] as string[] };

function frozenManifest(fallbackProfileIds: readonly string[] = ['anthropic-extractor']) {
  const adapterBehavior = createCurrentAdapterBehaviorSnapshot();
  return freezeManifest({
    manifestVersion: 1,
    adapterBehavior,
    agents: { 'logo-agent': { name: 'logo-agent', description: 'Logo', version: '1.0.0', skills: [], promptHint: 'Use neutral Spanish' } },
    models: [
      { id: 'openrouter-extractor', purpose: 'extractor', provider: 'openrouter', model: 'google/gemini-2.5-flash', modelRevision: null, credentialRef: 'platform.openrouter', capabilities: fields.forced, settings: { temperature: 0, maxTokens: 512 } },
      ...(fallbackProfileIds.length ? [{ id: 'anthropic-extractor', purpose: 'extractor' as const, provider: 'anthropic' as const, model: 'claude-haiku-5-5', modelRevision: null, credentialRef: 'platform.anthropic', capabilities: fields.forced, settings: { temperature: 1, maxTokens: 512 } }] : []),
      { id: 'openrouter-responder', purpose: 'responder', provider: 'openrouter', model: 'google/gemini-2.5-pro', modelRevision: null, credentialRef: 'platform.openrouter', capabilities: fields.ordinary, settings: { temperature: 0.7, maxTokens: 1800 } },
    ],
    fallback: {
      extractor: { primaryProfileId: 'openrouter-extractor', fallbackProfileIds, maxAttempts: fallbackProfileIds.length ? 2 : 1 },
      responder: { primaryProfileId: 'openrouter-responder', fallbackProfileIds: [], maxAttempts: 1 },
    },
    planner: { version: 'planner.v1', thresholds: { confidence: { autoAccept: 0.9, confirm: 0.6 } } },
    merge: { version: 'merge.v1' },
    runtimeCompatibility: { min: '1.0.0', max: '1.0.0' },
    snapshot: { code: `sha256:${'a'.repeat(64)}`, dependencies: `sha256:${'b'.repeat(64)}`, sourceContentHashes: { 'source.ts': 'c'.repeat(64) } },
    externalRefs: { git: null, langsmith: null },
  });
}

function harness(options: { enabled?: Record<string, boolean>; providerFailures?: Set<string>; providerFailureCategory?: ProviderFailureCategory; failEvidence?: boolean; failFinishAfterCall?: boolean; releaseStatus?: 'frozen' | 'retired'; completionMode?: 'normal' | 'refusal' | 'truncated' | 'missing_tool' | 'malformed_tool' | 'secret'; noFallback?: boolean; usageDenied?: UsageDenialReason; settleFails?: boolean } = {}) {
  const frozen = frozenManifest(options.noFallback ? [] : undefined);
  const requests: Array<{ provider: string; request: ChatRequest }> = [];
  const finishes: Array<Record<string, unknown>> = [];
  const requestEvidence: string[] = [];
  const notices: Array<Record<string, unknown>> = [];
  const persistedAttempts: Array<{ attemptId: string; attemptNumber: number; effectiveProfileId: string; purpose: string; status: 'started' | 'succeeded' | 'failed' | 'uncertain'; failureCategory?: string | null; responseContent?: string | null }> = [];
  const callsByPurpose = new Map<string, number>();
  const clientProvider = (provider: string, modelIds: Record<string, string>): ILLMProvider => ({
    resolve(purpose) {
      const modelId = modelIds[purpose];
      const client: ResolvedModel['client'] = {
        chat: { completions: { create: vi.fn(async (request: ChatRequest): Promise<ChatCompletion> => {
          requests.push({ provider, request });
          callsByPurpose.set(purpose, (callsByPurpose.get(purpose) ?? 0) + 1);
          if (options.providerFailures?.has(provider)) throw new ProviderCallError(options.providerFailureCategory ?? 'ambiguous');
          const mode = options.completionMode ?? 'normal';
          return {
            id: 'completion-id',
            model: modelId,
            choices: [{
              message: {
                role: 'assistant',
                content: mode === 'refusal' ? 'blocked' : null,
                tool_calls: mode === 'missing_tool' ? [] : [{ type: 'function', function: { name: 'submit_extracted_fields', arguments: mode === 'malformed_tool' ? '{' : mode === 'secret' ? '{"fields":{},"note":"sk-ant-testsecretvalue123456789"}' : '{"fields":{}}' } }],
              },
              finish_reason: mode === 'refusal' ? 'content_filter' : mode === 'truncated' ? 'length' : 'stop',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          };
        }) } },
      };
      return { client, modelId, purpose, provider: provider as 'openrouter' | 'anthropic' };
    },
  });
  const attempts: AttemptWriter = {
    listAttempts: vi.fn(async ({ turnId: _turnId, purpose }) => persistedAttempts.filter((attempt) => attempt.purpose === purpose)),
    startAttempt: vi.fn(async (input) => {
      const attemptId = `attempt-${persistedAttempts.length + 1}`;
      persistedAttempts.push({ attemptId, attemptNumber: persistedAttempts.length + 1, effectiveProfileId: input.effectiveProfileId, purpose: input.purpose, status: 'started' });
      return attemptId;
    }),
    attachAttemptRequest: vi.fn(async ({ requestContent }) => { if (options.failEvidence) throw new Error('db unavailable'); JSON.parse(requestContent); requestEvidence.push(requestContent); }),
    finishAttempt: vi.fn(async (input) => {
      if ((options.failEvidence || options.failFinishAfterCall) && requests.length) throw new Error('db unavailable');
      finishes.push(input);
      const attempt = persistedAttempts.find((candidate) => candidate.attemptId === input.attemptId)!;
      attempt.status = input.outcome;
      attempt.failureCategory = input.failureCategory;
      attempt.responseContent = input.responseContent;
    }),
    recordNotice: vi.fn(async (input) => { notices.push(input); }),
  };
  // KAN-43 fake ledger: records every reservation and settlement in call order.
  const ledger: Array<{ op: 'reserve' | 'settle'; [key: string]: unknown }> = [];
  const usage: UsageLedger = {
    reserve: vi.fn(async (request) => {
      ledger.push({ op: 'reserve', ...request, requestsSoFar: requests.length });
      return options.usageDenied
        ? { allowed: false as const, reason: options.usageDenied, reservationId: `denied-${ledger.length}` }
        : { allowed: true as const, reservationId: `reservation-${ledger.length}` };
    }),
    settle: vi.fn(async (settlement) => {
      if (options.settleFails) throw new Error('db unavailable');
      ledger.push({ op: 'settle', ...settlement });
      return true;
    }),
  };
  const repositories: RuntimeRepositories = {
    config: {
      getPinnedRelease: vi.fn(async () => ({ state: 'pinned' as const, releaseId: 'release-a', release: { id: 'release-a', status: options.releaseStatus ?? 'frozen', manifest: frozen.content, contentHash: frozen.contentHash } })),
      getProviderAvailability: vi.fn(async (provider) => ({ enabled: options.enabled?.[provider] ?? true, version: 1 })),
    },
    attempts,
    usage,
  };
  const runtime = new AiConfigRuntime(() => repositories, new ProviderRegistry(
    (ref) => ref === 'platform.openrouter' ? 'open-key' : 'anthropic-key',
    (provider, _key, modelIds) => clientProvider(provider, modelIds),
  ), { runtimeVersion: '1.0.0', codeFingerprint: 'a'.repeat(64), dependencyFingerprint: 'b'.repeat(64) });
  return { runtime, requests, finishes, notices, attempts, requestEvidence, ledger, usage };
}

async function callExtractor(execution: Parameters<Parameters<AiConfigRuntime['runPurpose']>[2]>[0]) {
  const request: ChatRequest = {
    model: execution.model.modelId,
    messages: [{ role: 'user', content: 'hola' }],
    temperature: execution.behavior.extractor.temperature,
    max_tokens: execution.behavior.extractor.maxTokens,
    tools: [{ type: 'function', function: { name: execution.behavior.extractor.toolName, parameters: {} } }],
    tool_choice: execution.behavior.extractor.toolChoice,
  };
  return execution.model.client.chat.completions.create(request);
}

describe('assertExecutable (D22)', () => {
  const manifest = () => frozenManifest().content;

  it('does not gate on the code or dependency fingerprints: an earlier release stays usable after a deploy', () => {
    expect(() => assertExecutable(manifest(), { runtimeVersion: '1.0.0', codeFingerprint: 'c'.repeat(64), dependencyFingerprint: 'd'.repeat(64) })).not.toThrow();
  });

  it('still enforces the runtime version range', () => {
    expect(() => assertExecutable(manifest(), { runtimeVersion: '99.0.0', codeFingerprint: 'a'.repeat(64), dependencyFingerprint: 'b'.repeat(64) })).toThrow(/compatibility range/);
  });
});

describe('AiConfigRuntime', () => {
  it('uses the pinned profile regardless of the deployment default and keeps retired pins executable', async () => {
    const prior = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'anthropic';
    const { runtime, requests } = harness({ releaseStatus: 'retired' });
    const result = await runtime.runPurpose(identity, { conversationId: 'conversation-a', turnId: 'turn-a', ownerToken: 'owner-a', purpose: 'extractor' }, callExtractor);
    if (prior === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = prior;
    expect(result.effectiveProfileId).toBe('openrouter-extractor');
    expect(requests[0].provider).toBe('openrouter');
  });

  it('uses one approved compatible alternate with its frozen settings and records response usage and notice', async () => {
    const { runtime, requests, finishes, notices } = harness({ enabled: { openrouter: false } });
    const result = await runtime.runPurpose(identity, { conversationId: 'conversation-a', turnId: 'turn-b', ownerToken: 'owner-a', purpose: 'extractor' }, callExtractor);
    expect(result.effectiveProfileId).toBe('anthropic-extractor');
    expect(requests).toHaveLength(1);
    expect(requests[0].request.temperature).toBe(1);
    expect(finishes[0]).toMatchObject({ outcome: 'failed', failureCategory: 'provider_disabled' });
    expect(finishes[1]).toMatchObject({ outcome: 'succeeded', usage: { promptTokens: 12, completionTokens: 4 } });
    expect(notices[0]).toMatchObject({ code: 'approved_fallback_used' });
  });

  it('records the effective fallback provider, model, purpose and tokens in llm_calls (KAN-69 A6)', async () => {
    recordSpy.mockClear();
    const prior = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'openrouter';
    const { runtime, requests, finishes } = harness({ providerFailures: new Set(['openrouter']), providerFailureCategory: 'provider_unavailable' });
    try {
      // Mirrors the adapters: provenance comes from the resolved execution model.
      const result = await runtime.runPurpose(identity, { conversationId: 'conversation-a', turnId: 'turn-provenance', ownerToken: 'owner-a', purpose: 'extractor' }, async (execution) => {
        const provider = execution.model.provider;
        if (!provider) throw new Error('frozen execution must carry its provider');
        return withLlmLogging(execution.model.client, {
          model: execution.model.modelId,
          messages: [{ role: 'user', content: 'hola' }],
          temperature: execution.behavior.extractor.temperature,
          max_tokens: execution.behavior.extractor.maxTokens,
          tools: [{ type: 'function', function: { name: execution.behavior.extractor.toolName, parameters: {} } }],
          tool_choice: execution.behavior.extractor.toolChoice,
        }, { tenant: identity.tenant, user: identity.user, conversationId: 'conversation-a' as never, promptVersion: 'unit.v1', modelRevision: execution.model.modelRevision, provider, purpose: 'extractor' });
      });
      expect(result.effectiveProfileId).toBe('anthropic-extractor');
    } finally {
      if (prior === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prior;
    }
    expect(requests.map((request) => request.provider)).toEqual(['openrouter', 'anthropic']);
    expect(finishes[0]).toMatchObject({ outcome: 'failed', failureCategory: 'provider_unavailable' });
    // The failed primary attempt stays in ai_turn_attempts; only the served call is billed.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect((recordSpy.mock.calls[0] as unknown[])[0]).toMatchObject({
      provider: 'anthropic',
      purpose: 'extractor',
      model: 'claude-haiku-5-5',
      inputTokens: 12,
      outputTokens: 4,
    });
  });

  it('does not fall back or exceed a frozen one-attempt ceiling when no alternate is approved', async () => {
    const { runtime, requests, attempts } = harness({ enabled: { openrouter: false }, noFallback: true });
    await expect(runtime.runPurpose(identity, { conversationId: 'conversation-a', turnId: 'turn-one', ownerToken: 'owner-a', purpose: 'extractor' }, callExtractor))
      .rejects.toMatchObject({ category: 'provider_unavailable' });
    expect(attempts.startAttempt).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
  });

  it('does not repeat an ambiguous provider outcome', async () => {
    const { runtime, requests } = harness({ providerFailures: new Set(['openrouter']) });
    await expect(runtime.runPurpose(identity, { conversationId: 'conversation-a', turnId: 'turn-c', ownerToken: 'owner-a', purpose: 'extractor' }, callExtractor))
      .rejects.toMatchObject({ category: 'ambiguous_provider_outcome', ambiguous: true });
    expect(requests).toHaveLength(1);
  });

  it('never makes a paid request when request evidence cannot be written', async () => {
    const { runtime, requests } = harness({ failEvidence: true });
    await expect(runtime.runPurpose(identity, { conversationId: 'conversation-a', turnId: 'turn-d', ownerToken: 'owner-a', purpose: 'extractor' }, callExtractor))
      .rejects.toMatchObject({ category: 'execution_evidence_unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('does not fall back for refusal, truncation, missing forced tool output, or malformed tool JSON', async () => {
    for (const completionMode of ['refusal', 'truncated', 'missing_tool', 'malformed_tool'] as const) {
      const { runtime, requests, finishes } = harness({ completionMode });
      await expect(runtime.runPurpose(identity, { conversationId: 'conversation-a', turnId: `turn-${completionMode}`, ownerToken: 'owner-a', purpose: 'extractor' }, callExtractor))
        .rejects.toMatchObject({ category: 'provider_rejected' });
      expect(requests).toHaveLength(1);
      expect(finishes[0]).toMatchObject({ outcome: 'failed', failureCategory: 'invalid_response' });
    }
  });

  it('does not repeat a successful paid call when completion evidence cannot be written', async () => {
    const { runtime, requests } = harness({ failFinishAfterCall: true });
    await expect(runtime.runPurpose(identity, { conversationId: 'conversation-a', turnId: 'turn-f', ownerToken: 'owner-a', purpose: 'extractor' }, callExtractor))
      .rejects.toMatchObject({ category: 'execution_evidence_unavailable', ambiguous: true });
    expect(requests).toHaveLength(1);
  });

  it('redacts known and configured secrets from evidence without changing the provider request', async () => {
    const oldKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'configured-test-secret-123456';
    const { runtime, requests, requestEvidence, finishes } = harness({ completionMode: 'secret' });
    const originalRequestContent = `configured-test-secret-123456 sk-or-testsecretvalue123456789`;
    await runtime.runPurpose(identity, { conversationId: 'conversation-a', turnId: 'turn-secret', ownerToken: 'owner-a', purpose: 'extractor' }, (execution) => {
      const request: ChatRequest = {
        model: execution.model.modelId,
        messages: [{ role: 'user', content: originalRequestContent }],
        temperature: execution.behavior.extractor.temperature,
        max_tokens: execution.behavior.extractor.maxTokens,
        tools: [{ type: 'function', function: { name: execution.behavior.extractor.toolName, parameters: {} } }],
        tool_choice: execution.behavior.extractor.toolChoice,
      };
      return execution.model.client.chat.completions.create(request);
    });
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
    expect(requests[0].request.messages[0]).toMatchObject({ content: originalRequestContent });
    expect(requestEvidence[0]).not.toContain('configured-test-secret-123456');
    expect(requestEvidence[0]).toContain('[REDACTED]');
    expect(finishes[0].responseContent).not.toContain('sk-ant-testsecretvalue123456789');
    expect(finishes[0].responseContent).toContain('[REDACTED]');
  });

  it('does not call a model again after a successful attempt when a controller checkpoint is missing', async () => {
    const { runtime, requests } = harness();
    const input = { conversationId: 'conversation-a', turnId: 'turn-g', ownerToken: 'owner-a', purpose: 'extractor' as const };
    await runtime.runPurpose(identity, input, callExtractor);
    await expect(runtime.runPurpose(identity, input, callExtractor))
      .rejects.toMatchObject({ category: 'ambiguous_provider_outcome', ambiguous: true });
    expect(requests).toHaveLength(1);
  });

  describe('usage gateway (KAN-43)', () => {
    const turn = (turnId: string) => ({ conversationId: 'conversation-a', turnId, ownerToken: 'owner-a', purpose: 'extractor' as const });

    it('allowed: reserves an estimate before the provider call and settles the real token cost after it', async () => {
      const { runtime, requests, ledger } = harness();
      await runtime.runPurpose(identity, turn('turn-usage-ok'), callExtractor);
      expect(requests).toHaveLength(1);
      expect(ledger).toHaveLength(2);
      expect(ledger[0]).toMatchObject({ op: 'reserve', kind: 'llm', provider: 'openrouter', model: 'google/gemini-2.5-flash', conversationId: 'conversation-a', turnId: 'turn-usage-ok', attemptId: 'attempt-1', requestsSoFar: 0 });
      expect(ledger[0].estimatedCostUsd as number).toBeGreaterThan(0);
      expect(ledger[1]).toEqual({ op: 'settle', reservationId: 'reservation-1', outcome: 'succeeded', actualCostUsd: llmCostUsd('google/gemini-2.5-flash', { prompt_tokens: 12, completion_tokens: 4 }) });
    });

    it('denied: never calls the provider or a fallback, fails the attempt and carries the reason', async () => {
      const { runtime, requests, finishes, attempts, usage } = harness({ usageDenied: 'tenant_budget' });
      await expect(runtime.runPurpose(identity, turn('turn-usage-denied'), callExtractor))
        .rejects.toMatchObject({ category: 'usage_limited', usageDenial: 'tenant_budget', ambiguous: false });
      expect(requests).toHaveLength(0);
      expect(attempts.startAttempt).toHaveBeenCalledTimes(1);
      expect(finishes).toEqual([expect.objectContaining({ outcome: 'failed', failureCategory: 'usage_limited' })]);
      expect(usage.settle).not.toHaveBeenCalled();
    });

    it('failure and retry: each attempt reserves; an unbilled failure settles at 0, the fallback at its real cost', async () => {
      const { runtime, requests, ledger } = harness({ providerFailures: new Set(['openrouter']), providerFailureCategory: 'provider_unavailable' });
      await runtime.runPurpose(identity, turn('turn-usage-retry'), callExtractor);
      expect(requests.map((request) => request.provider)).toEqual(['openrouter', 'anthropic']);
      expect(ledger.map(({ op, outcome, provider }) => ({ op, outcome, provider }))).toEqual([
        { op: 'reserve', outcome: undefined, provider: 'openrouter' },
        { op: 'settle', outcome: 'failed', provider: undefined },
        { op: 'reserve', outcome: undefined, provider: 'anthropic' },
        { op: 'settle', outcome: 'succeeded', provider: undefined },
      ]);
      expect(ledger[1].actualCostUsd).toBe(0);
      expect(ledger[3].actualCostUsd).toBe(llmCostUsd('claude-haiku-5-5', { prompt_tokens: 12, completion_tokens: 4 }));
    });

    it('an ambiguous failure keeps the estimate, since the provider may have billed it', async () => {
      const { runtime, ledger } = harness({ providerFailures: new Set(['openrouter']) });
      await expect(runtime.runPurpose(identity, turn('turn-usage-ambiguous'), callExtractor)).rejects.toMatchObject({ category: 'ambiguous_provider_outcome' });
      expect(ledger[1]).toMatchObject({ op: 'settle', outcome: 'failed', actualCostUsd: ledger[0].estimatedCostUsd });
    });

    it('a refused completion was still billed: settles the real cost before validation fails', async () => {
      const { runtime, ledger } = harness({ completionMode: 'refusal' });
      await expect(runtime.runPurpose(identity, turn('turn-usage-refusal'), callExtractor)).rejects.toMatchObject({ category: 'provider_rejected' });
      expect(ledger[1]).toMatchObject({ op: 'settle', outcome: 'succeeded', actualCostUsd: llmCostUsd('google/gemini-2.5-flash', { prompt_tokens: 12, completion_tokens: 4 }) });
    });

    it('a lost settlement does not fail a paid call', async () => {
      const { runtime, requests } = harness({ settleFails: true });
      await expect(runtime.runPurpose(identity, turn('turn-usage-settle'), callExtractor)).resolves.toMatchObject({ effectiveProfileId: 'openrouter-extractor' });
      expect(requests).toHaveLength(1);
    });
  });
});
