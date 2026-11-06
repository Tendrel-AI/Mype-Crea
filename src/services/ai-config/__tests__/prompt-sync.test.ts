import { describe, expect, it, vi } from 'vitest';
import type { ResolvedIdentity } from '../../../auth/resolve-identity';
import type { SharedReleaseRecord, AiConfigRepository } from '../service';
import { createCurrentAdapterBehaviorSnapshot } from '../adapter-behavior';
import { freezeManifest } from '../manifest';
import { AiPromptSyncService, type LangSmithPromptClient } from '../prompt-sync';

const admin = {
  tenant: { id: 'tenant-a' }, user: { id: 'user-a' }, tenantRole: 'admin',
  workosUserId: 'workos_admin', organizationId: 'org-a', platformAdmin: true,
} as unknown as ResolvedIdentity;
const member = { ...admin, tenantRole: 'member', platformAdmin: false } as unknown as ResolvedIdentity;

function buildManifest() {
  return {
    manifestVersion: 1,
    adapterBehavior: createCurrentAdapterBehaviorSnapshot(),
    agents: { 'logo-agent': { name: 'logo-agent', description: 'Logo agent', version: '1.0.0', skills: [], promptHint: 'Usa español neutro latinoamericano y trata al usuario de tú.' } },
    models: [
      { id: 'extractor-primary', purpose: 'extractor', provider: 'openrouter', model: 'google/gemini-2.5-flash', modelRevision: null, credentialRef: 'platform.openrouter', capabilities: ['forced-tool-call', 'json-schema'], settings: { temperature: 0, maxTokens: 512 } },
      { id: 'responder-primary', purpose: 'responder', provider: 'openrouter', model: 'google/gemini-2.5-pro', modelRevision: null, credentialRef: 'platform.openrouter', capabilities: [], settings: { temperature: 0.7, maxTokens: 1200 } },
    ],
    fallback: {
      extractor: { primaryProfileId: 'extractor-primary', fallbackProfileIds: [], maxAttempts: 1 },
      responder: { primaryProfileId: 'responder-primary', fallbackProfileIds: [], maxAttempts: 1 },
    },
    planner: { version: 'planner.v1', thresholds: { confidence: { required: 0.8 } } },
    merge: { version: 'merge.v1' },
    runtimeCompatibility: { min: '1.0.0', max: '2.0.0' },
    snapshot: { code: `sha256:${'a'.repeat(64)}`, dependencies: `sha256:${'b'.repeat(64)}`, sourceContentHashes: { 'source.ts': 'c'.repeat(64) } },
    externalRefs: { git: null, langsmith: null },
  };
}

function setup(client: LangSmithPromptClient, options: { recordFails?: boolean; recordFailsAt?: number } = {}) {
  const frozen = freezeManifest(buildManifest());
  const release: SharedReleaseRecord = {
    id: 'shared-a', name: 'Base', status: 'frozen', draftVersion: 2, manifest: frozen.content,
    contentHash: frozen.contentHash, allowedOverridePaths: [],
  };
  const events: Array<Record<string, unknown>> = [];
  let auditCalls = 0;
  const repository = {
    getSharedRelease: vi.fn(async () => release),
    listSyncEvents: vi.fn(async () => events.map((metadata) => ({ metadata, occurredAt: '2026-10-18T00:00:00Z' }))),
    recordSyncEvent: vi.fn(async (event: Record<string, unknown>) => {
      auditCalls += 1;
      if (options.recordFails || auditCalls === options.recordFailsAt) throw new Error('audit unavailable');
      events.push(event);
    }),
  } as unknown as AiConfigRepository;
  const clientFactory = vi.fn(() => client);
  const createSharedDraft = vi.fn(async (_identity: ResolvedIdentity, input: { name: string; manifest: unknown; allowedOverridePaths: readonly string[] }) => ({ id: 'draft-a', input }));
  const api = new AiPromptSyncService(() => repository, clientFactory, () => ({ createSharedDraft }) as never);
  return { api, release, repository, clientFactory, events, createSharedDraft };
}

describe('AiPromptSyncService', () => {
  it('publishes only a private hash-addressed frozen manifest and records the returned commit', async () => {
    const pushPrompt = vi.fn(async (_name: string, _options: unknown) => 'https://smith.langchain.com/prompts/name/abcdef12345678?organizationId=org');
    const client: LangSmithPromptClient = { pushPrompt, pullPromptCommit: vi.fn() };
    const { api, release, events } = setup(client);

    const result = await api.publishShared(admin, release.id);

    expect(pushPrompt).toHaveBeenCalledTimes(1);
    const [prompt, options] = pushPrompt.mock.calls[0] as unknown as [string, { object: Record<string, unknown>; isPublic: boolean }];
    expect(prompt).toBe(`mypes-ai-config-${release.contentHash}`);
    expect(options.isPublic).toBe(false);
    expect(options.object).toMatchObject({ format: 'mypes.ai-config.v1', contentHash: release.contentHash, content: release.manifest });
    expect(JSON.stringify(options.object)).not.toMatch(/conversation|trace|apiKey|OPENROUTER_API_KEY/);
    expect(result.commit).toBe('abcdef12345678');
    expect(events.map((event) => event.status)).toEqual(['started', 'succeeded']);
  });

  it('records a safe failed status when the remote request fails and never leaks SDK error text', async () => {
    const client: LangSmithPromptClient = {
      pushPrompt: vi.fn(async () => { throw new Error('secret endpoint and API key detail'); }),
      pullPromptCommit: vi.fn(),
    };
    const { api, release, events } = setup(client);
    await expect(api.publishShared(admin, release.id)).rejects.toThrow(/No se pudo completar/);
    expect(events.map((event) => event.status)).toEqual(['started', 'failed']);
    expect(events[1]).toMatchObject({ safeErrorCategory: 'langsmith_request_failed' });
    expect(JSON.stringify(events)).not.toMatch(/secret endpoint|API key detail/);
  });

  it('does not call LangSmith when the started audit event cannot be persisted', async () => {
    const client: LangSmithPromptClient = { pushPrompt: vi.fn(), pullPromptCommit: vi.fn() };
    const { api, release } = setup(client, { recordFails: true });
    await expect(api.publishShared(admin, release.id)).rejects.toThrow(/audit unavailable/);
    expect(client.pushPrompt).not.toHaveBeenCalled();
  });

  it('leaves a visible failed audit when the provider upload succeeds but the success write fails', async () => {
    const pushPrompt = vi.fn(async () => 'https://smith.langchain.com/prompts/name/abcdef12345678');
    const client: LangSmithPromptClient = { pushPrompt, pullPromptCommit: vi.fn() };
    const { api, release, events } = setup(client, { recordFailsAt: 2 });
    await expect(api.publishShared(admin, release.id)).rejects.toThrow(/No se pudo completar/);
    expect(pushPrompt).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.status)).toEqual(['started', 'failed']);
    expect(events[1]).toMatchObject({ safeErrorCategory: 'commit_reference_unavailable', pinnedCommit: 'abcdef12345678' });
  });

  it('requires admin authority and refuses foreign or unpinned prompt imports before network access', async () => {
    const client: LangSmithPromptClient = { pushPrompt: vi.fn(), pullPromptCommit: vi.fn() };
    const { api } = setup(client);
    await expect(api.publishShared(member, 'shared-a')).rejects.toThrow(/administration/);
    await expect(api.importSharedPrompt(admin, { name: 'Bad', prompt: 'someone/foreign', commit: 'abcdef12' })).rejects.toThrow(/content-addressed/);
    await expect(api.importSharedPrompt(admin, { name: 'Bad', prompt: `mypes-ai-config-${'a'.repeat(64)}`, commit: 'latest' })).rejects.toThrow(/explicit prompt commit/);
    expect(client.pullPromptCommit).not.toHaveBeenCalled();
  });

  it('pulls an explicit raw commit and passes a validated pinned manifest to draft import', async () => {
    const frozen = freezeManifest(buildManifest());
    const pullPromptCommit = vi.fn(async (identifier: string, options: { includeModel: false; skipCache: true }) => {
      expect(identifier).toBe(`mypes-ai-config-${frozen.contentHash}:abcdef12`);
      expect(options).toEqual({ includeModel: false, skipCache: true });
      return { commit_hash: 'abcdef12345678', manifest: { format: 'mypes.ai-config.v1', contentHash: frozen.contentHash, content: frozen.content } };
    });
    const client: LangSmithPromptClient = { pushPrompt: vi.fn(), pullPromptCommit };
    const { api, events, createSharedDraft } = setup(client);
    const imported = await api.importSharedPrompt(admin, {
      name: 'Imported base', prompt: `mypes-ai-config-${frozen.contentHash}`, commit: 'abcdef12',
    });
    expect(imported).toMatchObject({ id: 'draft-a' });
    expect(pullPromptCommit).toHaveBeenCalledTimes(1);
    const importedInput = createSharedDraft.mock.calls[0]?.[1];
    expect(importedInput?.allowedOverridePaths).toEqual([]);
    expect((importedInput?.manifest as { externalRefs: { langsmith: unknown } }).externalRefs.langsmith).toEqual({ prompt: `mypes-ai-config-${frozen.contentHash}`, commit: 'abcdef12345678' });
    expect(events.map((event) => event.status)).toEqual(['started', 'succeeded']);
  });

  it('reuses the failed operation commit when it already contains the frozen content', async () => {
    const frozen = freezeManifest(buildManifest());
    const pullPromptCommit = vi.fn(async () => ({
      commit_hash: 'abcdef12345678',
      manifest: { format: 'mypes.ai-config.v1', contentHash: frozen.contentHash, content: frozen.content },
    }));
    const pushPrompt = vi.fn();
    const client: LangSmithPromptClient = { pushPrompt, pullPromptCommit };
    const { api, release, events } = setup(client);
    events.push({ operationId: 'parent-operation', destination: 'langsmith', action: 'prompt_publish', status: 'failed', contentHash: frozen.contentHash, pinnedCommit: 'abcdef12' });
    const result = await api.retrySharedPublish(admin, { releaseId: release.id, parentOperationId: 'parent-operation' });
    expect(result.commit).toBe('abcdef12345678');
    expect(pullPromptCommit).toHaveBeenCalledWith(`mypes-ai-config-${frozen.contentHash}:abcdef12`, { includeModel: false, skipCache: true });
    expect(pushPrompt).not.toHaveBeenCalled();
    expect(events.filter((event) => event.action === 'retry').map((event) => event.status)).toEqual(['started', 'succeeded']);
  });
});
