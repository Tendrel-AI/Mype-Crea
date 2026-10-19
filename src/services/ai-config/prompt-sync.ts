import { randomUUID } from 'node:crypto';
import { Client } from 'langsmith';
import type { ResolvedIdentity } from '../../auth/resolve-identity';
import { AiConfigService, type AiConfigRepository, type AiConfigRepositoryFactory, type SyncOperationEvent } from './service';
import { freezeManifest, importManifest, type AiConfigManifestV1 } from './manifest';

const PROMPT_NAME = /^mypes-ai-config-([a-f0-9]{64})$/;
const COMMIT = /^[a-f0-9]{8,64}$/i;
const SAFE_ERROR = 'langsmith_request_failed';

export interface RawPromptCommit {
  readonly commit_hash: string;
  readonly manifest: unknown;
}

/** Narrow surface over LangSmith's raw JSON prompt APIs; never loads a Runnable. */
export interface LangSmithPromptClient {
  pushPrompt(identifier: string, options: { object: unknown; isPublic: false; description: string }): Promise<string>;
  pullPromptCommit(identifier: string, options: { includeModel: false; skipCache: true }): Promise<RawPromptCommit>;
}

export type LangSmithPromptClientFactory = () => LangSmithPromptClient;
export type AiConfigServiceFactory = (identity: ResolvedIdentity) => AiConfigService;

export interface PromptSyncResult {
  readonly operationId: string;
  readonly prompt: string;
  readonly commit: string;
  readonly contentHash: string;
}

/** Explicit platform-admin sync for inert AI configuration JSON only. */
export class AiPromptSyncService {
  constructor(
    private readonly repositoriesFor: AiConfigRepositoryFactory,
    private readonly clientFactory: LangSmithPromptClientFactory = createLangSmithClient,
    private readonly configServiceFor: AiConfigServiceFactory = (identity) => new AiConfigService(repositoriesFor),
  ) {}

  async publishShared(identity: ResolvedIdentity, releaseId: string): Promise<PromptSyncResult> {
    requireSyncAdmin(identity);
    const repository = this.repositoriesFor(identity);
    const release = await repository.getSharedRelease(releaseId);
    if (!release || release.status !== 'frozen' || !release.contentHash) throw new Error('Only a frozen shared release can be published.');
    const frozen = freezeManifest(release.manifest);
    if (frozen.contentHash !== release.contentHash) throw new Error('Shared release hash is invalid.');
    const prompt = promptName(frozen.contentHash);
    return this.publish(identity, repository, { prompt, content: frozen.content, contentHash: frozen.contentHash });
  }

  async retrySharedPublish(identity: ResolvedIdentity, input: { releaseId: string; parentOperationId: string }): Promise<PromptSyncResult> {
    requireSyncAdmin(identity);
    const repository = this.repositoriesFor(identity);
    const parent = (await repository.listSyncEvents({ limit: 200 }))
      .find((event) => event.metadata.operationId === input.parentOperationId)?.metadata;
    if (!parent || parent.destination !== 'langsmith' || parent.status !== 'failed' ||
      (parent.action !== 'prompt_publish' && parent.action !== 'retry')) {
      throw new Error('A failed LangSmith publish operation is required for retry.');
    }
    const release = await repository.getSharedRelease(input.releaseId);
    if (!release || release.status !== 'frozen' || !release.contentHash || parent.contentHash !== release.contentHash) {
      throw new Error('The retry release does not match the failed operation.');
    }
    const frozen = freezeManifest(release.manifest);
    if (frozen.contentHash !== release.contentHash) throw new Error('Shared release hash is invalid.');
    const prompt = promptName(frozen.contentHash);
    if (parent.pinnedCommit) {
      let alreadyPublished: RawPromptCommit | undefined;
      try {
        const existing = await this.pullRaw(prompt, parent.pinnedCommit);
        if (!existing.commit_hash.toLowerCase().startsWith(parent.pinnedCommit.toLowerCase())) throw new Error('Pinned commit mismatch.');
        if (readEnvelope(existing.manifest, frozen.contentHash).contentHash === frozen.contentHash) alreadyPublished = existing;
      } catch {
        // The explicit retry below may republish the same content if the prior commit is no longer readable.
      }
      if (alreadyPublished) {
        const operationId = randomUUID();
        await repository.recordSyncEvent({ operationId, destination: 'langsmith', action: 'retry', status: 'started', contentHash: frozen.contentHash, pinnedCommit: parent.pinnedCommit, parentOperationId: parent.operationId });
        await repository.recordSyncEvent({ operationId, destination: 'langsmith', action: 'retry', status: 'succeeded', contentHash: frozen.contentHash, pinnedCommit: alreadyPublished.commit_hash.toLowerCase(), parentOperationId: parent.operationId });
        return Object.freeze({ operationId, prompt, commit: alreadyPublished.commit_hash.toLowerCase(), contentHash: frozen.contentHash });
      }
    }
    return this.publish(identity, repository, { prompt, content: frozen.content, contentHash: frozen.contentHash }, parent.operationId);
  }

  async importSharedPrompt(identity: ResolvedIdentity, input: {
    readonly name: string;
    readonly prompt: string;
    readonly commit: string;
  }) {
    requireSyncAdmin(identity);
    const promptHash = parsePromptName(input.prompt);
    if (!COMMIT.test(input.commit)) throw new Error('An explicit prompt commit is required.');
    const repository = this.repositoriesFor(identity);
    const operationId = randomUUID();
    await repository.recordSyncEvent({ operationId, destination: 'langsmith', action: 'prompt_import', status: 'started', contentHash: promptHash, pinnedCommit: input.commit.toLowerCase() });
    try {
      const remote = await this.pullRaw(input.prompt, input.commit.toLowerCase());
      const envelope = readEnvelope(remote.manifest, promptHash);
      const actualCommit = remote.commit_hash.toLowerCase();
      if (!actualCommit.startsWith(input.commit.toLowerCase())) throw new Error('commit_mismatch');
      const manifestWithPin = withLangSmithPin(envelope.content, input.prompt, actualCommit);
      const draft = await this.configServiceFor(identity).createSharedDraft(identity, {
        name: input.name,
        manifest: manifestWithPin,
        allowedOverridePaths: [],
      });
      await repository.recordSyncEvent({ operationId, destination: 'langsmith', action: 'prompt_import', status: 'succeeded', contentHash: freezeManifest(manifestWithPin).contentHash, pinnedCommit: actualCommit });
      return draft;
    } catch {
      await safeRecordFailure(repository, { operationId, destination: 'langsmith', action: 'prompt_import', status: 'failed', contentHash: promptHash, pinnedCommit: input.commit.toLowerCase(), safeErrorCategory: 'langsmith_import_failed' });
      throw new Error('No se pudo importar el prompt fijado. Verifica el commit y los permisos del release base.');
    }
  }

  private async publish(
    identity: ResolvedIdentity,
    repository: AiConfigRepository,
    input: { readonly prompt: string; readonly content: AiConfigManifestV1; readonly contentHash: string },
    parentOperationId?: string,
  ): Promise<PromptSyncResult> {
    const operationId = randomUUID();
    const action = parentOperationId ? 'retry' : 'prompt_publish';
    await repository.recordSyncEvent({ operationId, destination: 'langsmith', action, status: 'started', contentHash: input.contentHash, ...(parentOperationId ? { parentOperationId } : {}) });
    let pushedUrl: string | undefined;
    try {
      const client = this.clientFactory();
      pushedUrl = await client.pushPrompt(input.prompt, {
        object: { format: 'mypes.ai-config.v1', contentHash: input.contentHash, content: input.content },
        isPublic: false,
        description: 'Private frozen CreaMype AI configuration; inert JSON only.',
      });
      const commit = commitFromUrl(pushedUrl);
      await repository.recordSyncEvent({ operationId, destination: 'langsmith', action, status: 'succeeded', contentHash: input.contentHash, pinnedCommit: commit, ...(parentOperationId ? { parentOperationId } : {}) });
      return Object.freeze({ operationId, prompt: input.prompt, commit, contentHash: input.contentHash });
    } catch {
      await safeRecordFailure(repository, {
        operationId,
        destination: 'langsmith',
        action,
        status: 'failed',
        contentHash: input.contentHash,
        ...(pushedUrl ? { pinnedCommit: safeCommitFromUrl(pushedUrl) } : {}),
        safeErrorCategory: pushedUrl ? 'commit_reference_unavailable' : 'langsmith_request_failed',
        ...(parentOperationId ? { parentOperationId } : {}),
      });
      throw new Error('No se pudo completar la sincronización del prompt. Revisa el estado y usa Reintentar si corresponde.');
    }
  }

  private async pullRaw(prompt: string, commit: string): Promise<RawPromptCommit> {
    if (!PROMPT_NAME.test(prompt) || !COMMIT.test(commit)) throw new Error('Pinned internal prompt reference is invalid.');
    const client = this.clientFactory();
    return client.pullPromptCommit(`${prompt}:${commit}`, { includeModel: false, skipCache: true });
  }
}

function createLangSmithClient(): LangSmithPromptClient {
  const apiKey = process.env.LANGSMITH_API_KEY?.trim();
  if (!apiKey) throw new Error('LangSmith is not configured.');
  return new Client({ apiKey }) as unknown as LangSmithPromptClient;
}

function requireSyncAdmin(identity: ResolvedIdentity): void {
  if (!identity.platformAdmin) throw new Error('Prompt sync requires platform administration.');
}

function promptName(contentHash: string): string {
  return `mypes-ai-config-${contentHash}`;
}

function parsePromptName(prompt: string): string {
  const match = PROMPT_NAME.exec(prompt);
  if (!match) throw new Error('Only private CreaMype content-addressed prompts are accepted.');
  return match[1];
}

function commitFromUrl(raw: string): string {
  const commit = safeCommitFromUrl(raw);
  if (!commit) throw new Error('LangSmith did not return a pinned commit reference.');
  return commit;
}

function safeCommitFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return undefined;
    const candidate = url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase();
    return candidate && COMMIT.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function readEnvelope(value: unknown, expectedHash: string): { readonly content: AiConfigManifestV1; readonly contentHash: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prompt manifest is invalid.');
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).some((key) => !['format', 'contentHash', 'content'].includes(key))) {
    throw new Error('Prompt envelope contains unsupported fields.');
  }
  if (envelope.format !== 'mypes.ai-config.v1' || envelope.contentHash !== expectedHash || !Object.hasOwn(envelope, 'content')) {
    throw new Error('Prompt content hash or format is invalid.');
  }
  const frozen = importManifest(JSON.stringify(envelope.content));
  if (frozen.contentHash !== expectedHash) throw new Error('Prompt content integrity does not match its name.');
  return Object.freeze({ content: frozen.content, contentHash: frozen.contentHash });
}

function withLangSmithPin(manifest: AiConfigManifestV1, prompt: string, commit: string): AiConfigManifestV1 {
  return importManifest(JSON.stringify({
    ...manifest,
    externalRefs: { ...manifest.externalRefs, langsmith: { prompt, commit } },
  })).content;
}

async function safeRecordFailure(
  repository: AiConfigRepository,
  event: Parameters<AiConfigRepository['recordSyncEvent']>[0],
): Promise<void> {
  try {
    await repository.recordSyncEvent(event);
  } catch {
    // A failed sink remains visible as a missing terminal status after the started event.
  }
}
