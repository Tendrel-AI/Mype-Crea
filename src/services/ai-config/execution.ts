import { randomUUID } from 'node:crypto';
import { knownSecrets } from '../secrets/redaction';
import type { ResolvedIdentity } from '../../auth/resolve-identity';
import type { AdapterExecution, AdapterBehaviorSnapshot } from './adapter-behavior';
import type { ChatCompletion, ChatRequest, ResolvedModel } from '../llm/types';
import { ProviderRegistry, ProfileUnavailableError } from './provider-registry';
import { ProviderCallError } from '../llm/provider-error';
import { freezeManifest, type AiConfigManifestV1, type ModelProfile, type Purpose } from './manifest';
import { runWithUsage, UsageLimitError, type UsageLedger } from '../usage/gateway';
import { estimateLlmCostUsd, llmActualCost, type UsageDenialReason } from '../usage/policy';

export type ExecutionFailureCategory =
  | 'legacy_unversioned'
  | 'unsupported_release'
  | 'release_unavailable'
  | 'profile_unavailable'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'ambiguous_provider_outcome'
  | 'execution_evidence_unavailable'
  | 'usage_limited';

export class AiConfigExecutionError extends Error {
  constructor(
    readonly category: ExecutionFailureCategory,
    readonly correlationId: string,
    readonly ambiguous: boolean,
    readonly retryable: boolean,
    /** Set only for `usage_limited` (KAN-43): which limit denied the call. */
    readonly usageDenial?: UsageDenialReason,
  ) {
    super(`AI configuration execution failed: ${category}.`);
    this.name = 'AiConfigExecutionError';
  }
}

export interface FallbackNotice {
  readonly code: 'approved_fallback_used';
  readonly content: string;
}

export interface RuntimeRelease {
  readonly id: string;
  readonly status: 'draft' | 'frozen' | 'retired';
  readonly manifest: AiConfigManifestV1;
  readonly contentHash: string | null;
}

export interface PinnedReleaseResult {
  readonly state: 'pinned' | 'legacy_unversioned';
  readonly releaseId?: string;
  readonly release?: RuntimeRelease;
}

export interface RuntimeStore {
  getPinnedRelease(conversationId: string): Promise<PinnedReleaseResult | undefined>;
  getProviderAvailability(provider: ModelProfile['provider']): Promise<{ readonly enabled: boolean; readonly version: number }>;
}

export interface StartAttemptInput {
  readonly turnId: string;
  readonly ownerToken: string;
  readonly purpose: Purpose;
  readonly primaryProfileId: string;
  readonly effectiveProfileId: string;
  readonly provider: ModelProfile['provider'];
  readonly model: string;
  readonly modelRevision: string | null;
  readonly requestContent: string;
}

export interface AttemptWriter {
  listAttempts(input: { readonly turnId: string; readonly purpose: Purpose }): Promise<ReadonlyArray<{
    readonly attemptNumber: number;
    readonly effectiveProfileId: string;
    readonly status: 'started' | 'succeeded' | 'failed' | 'uncertain';
    readonly responseContent?: string | null;
    readonly failureCategory?: string | null;
  }>>;
  startAttempt(input: StartAttemptInput): Promise<string>;
  attachAttemptRequest(input: { readonly attemptId: string; readonly turnId: string; readonly ownerToken: string; readonly requestContent: string }): Promise<void>;
  finishAttempt(input: {
    readonly attemptId: string;
    readonly turnId: string;
    readonly ownerToken: string;
    readonly outcome: 'succeeded' | 'failed' | 'uncertain';
    readonly responseContent?: string;
    readonly failureCategory?: string | null;
    readonly providerStatus?: number | null;
    readonly usage?: { readonly promptTokens?: number | null; readonly completionTokens?: number | null; readonly totalTokens?: number | null; readonly latencyMs?: number | null };
    readonly cost?: null;
  }): Promise<void>;
  recordNotice(input: {
    readonly turnId: string;
    readonly ownerToken: string;
    readonly code: FallbackNotice['code'];
    readonly content: string;
  }): Promise<void>;
}

export interface RuntimeRepositories {
  readonly config: RuntimeStore;
  readonly attempts: AttemptWriter;
  /** KAN-43 usage ledger: every provider call reserves and settles here. */
  readonly usage: UsageLedger;
}

export type RuntimeRepositoryFactory = (identity: ResolvedIdentity) => RuntimeRepositories;

export interface RuntimeIdentity {
  readonly runtimeVersion: string;
  readonly codeFingerprint: string;
  readonly dependencyFingerprint: string;
}

export interface PurposeRunInput {
  readonly conversationId: string;
  readonly turnId: string;
  readonly ownerToken: string;
  readonly purpose: Purpose;
}

export interface PurposeRunResult<T> {
  readonly value: T;
  readonly effectiveProfileId: string;
  readonly fallbackNotice?: FallbackNotice;
}

export class AiConfigRuntime {
  constructor(
    private readonly repositoriesFor: RuntimeRepositoryFactory,
    private readonly providers: ProviderRegistry,
    private readonly runtimeIdentity: RuntimeIdentity,
  ) {}

  async runPurpose<T>(
    identity: ResolvedIdentity,
    input: PurposeRunInput,
    operation: (execution: AdapterExecution) => Promise<T>,
  ): Promise<PurposeRunResult<T>> {
    const correlationId = randomUUID();
    const { config: store, attempts, usage } = this.repositoriesFor(identity);
    const pinned = await store.getPinnedRelease(input.conversationId);
    if (!pinned || pinned.state === 'legacy_unversioned' || !pinned.release) {
      throw executionError('legacy_unversioned', correlationId, false, false);
    }
    const release = pinned.release;
    if ((release.status !== 'frozen' && release.status !== 'retired') || !release.contentHash) {
      throw executionError('release_unavailable', correlationId, false, false);
    }

    let manifest: AiConfigManifestV1;
    try {
      const frozen = freezeManifest(release.manifest);
      if (frozen.contentHash !== release.contentHash) throw new Error('content hash mismatch');
      manifest = frozen.content;
      assertExecutable(manifest, this.runtimeIdentity);
    } catch {
      throw executionError('unsupported_release', correlationId, false, false);
    }

    const chain = manifest.fallback[input.purpose];
    const profileById = new Map(manifest.models.map((profile) => [profile.id, profile]));
    const profileIds = [chain.primaryProfileId, ...chain.fallbackProfileIds].slice(0, chain.maxAttempts);
    const primary = profileById.get(chain.primaryProfileId);
    if (!primary) throw executionError('unsupported_release', correlationId, false, false);

    let priorAttempts: Awaited<ReturnType<AttemptWriter['listAttempts']>>;
    try {
      priorAttempts = await attempts.listAttempts({ turnId: input.turnId, purpose: input.purpose });
    } catch {
      throw executionError('execution_evidence_unavailable', correlationId, false, false);
    }
    if (priorAttempts.length > chain.maxAttempts || priorAttempts.some((attempt, index) => attempt.effectiveProfileId !== profileIds[index])) {
      throw executionError('unsupported_release', correlationId, false, false);
    }
    if (priorAttempts.some((attempt) => attempt.status === 'started' || attempt.status === 'succeeded' || attempt.status === 'uncertain')) {
      throw executionError('ambiguous_provider_outcome', correlationId, true, false);
    }
    const priorFailure = priorAttempts[priorAttempts.length - 1];
    if (priorFailure && !isFallbackEligibleCategory(priorFailure.failureCategory)) {
      throw executionError('provider_rejected', correlationId, false, false);
    }
    const firstProfileIndex = priorAttempts.length;

    await this.providers.warmTenantKey(identity.tenant.id);
    let lastFailure: AiConfigExecutionError | undefined;
    for (let index = firstProfileIndex; index < profileIds.length; index += 1) {
      const profile = profileById.get(profileIds[index]);
      if (!profile) throw executionError('unsupported_release', correlationId, false, false);
      const available = await store.getProviderAvailability(profile.provider);
      let attemptId: string;
      try {
        attemptId = await attempts.startAttempt({
          turnId: input.turnId,
          ownerToken: input.ownerToken,
          purpose: input.purpose,
          primaryProfileId: primary.id,
          effectiveProfileId: profile.id,
          provider: profile.provider,
          model: profile.model,
          modelRevision: profile.modelRevision,
          requestContent: JSON.stringify({ releaseId: release.id, purpose: input.purpose, effectiveProfileId: profile.id }),
        });
      } catch {
        throw executionError('execution_evidence_unavailable', correlationId, false, false);
      }

      if (!available.enabled) {
        await finishAttemptOrThrow(attempts, attemptId, input.turnId, input.ownerToken, { outcome: 'failed', failureCategory: 'provider_disabled' }, correlationId);
        lastFailure = executionError('provider_unavailable', correlationId, false, false);
        if (hasNext(profileIds, index)) continue;
        break;
      }

      let model: ReturnType<ProviderRegistry['resolve']>;
      try {
        model = this.providers.resolve(profile, input.purpose, { tenantId: identity.tenant.id, releaseId: release.id, profileId: profile.id });
      } catch (error) {
        const canFallback = error instanceof ProfileUnavailableError &&
          (error.reason === 'credential_missing' || error.reason === 'provider_disabled' || error.reason === 'model_unavailable');
        await finishAttemptOrThrow(attempts, attemptId, input.turnId, input.ownerToken, { outcome: 'failed', failureCategory: error instanceof ProfileUnavailableError ? error.reason : 'profile_resolution_failed' }, correlationId);
        lastFailure = executionError('profile_unavailable', correlationId, false, false);
        if (canFallback && hasNext(profileIds, index)) continue;
        break;
      }

      let value: T;
      let behavior: AdapterBehaviorSnapshot;
      try {
        behavior = applyProfileSettings(manifest.adapterBehavior, input.purpose, profile);
      } catch {
        await finishAttemptOrThrow(attempts, attemptId, input.turnId, input.ownerToken, { outcome: 'failed', failureCategory: 'unsupported_profile_settings' }, correlationId);
        throw executionError('profile_unavailable', correlationId, false, false);
      }
      const capture: { completion?: ChatCompletion; startedAt: number } = { startedAt: Date.now() };
      try {
        const tracedModel = captureAttempt(
          model,
          attempts,
          usage,
          attemptId,
          input,
          capture,
          correlationId,
          async () => (await store.getProviderAvailability(profile.provider)).enabled,
        );
        value = await operation(Object.freeze({ model: tracedModel, behavior }));
        this.providers.noteCall(identity.tenant.id, profile.provider);
      } catch (error) {
        if (error instanceof UsageLimitError) {
          // KAN-43: denied before the provider was called; never substituted by a fallback.
          await finishAttemptOrThrow(attempts, attemptId, input.turnId, input.ownerToken, { outcome: 'failed', failureCategory: 'usage_limited' }, correlationId);
          throw new AiConfigExecutionError('usage_limited', correlationId, false, false, error.reason);
        }
        if (error instanceof AiConfigExecutionError) {
          await finishAttemptOrThrow(attempts, attemptId, input.turnId, input.ownerToken, {
            outcome: 'failed',
            failureCategory: error.category,
            responseContent: capture.completion ? redactEvidenceContent(JSON.stringify(capture.completion)) : undefined,
          }, correlationId);
          throw error;
        }
        if (error instanceof ProviderCallError) {
          const outcome = error.category === 'ambiguous' ? 'uncertain' : 'failed';
          await finishAttemptOrThrow(attempts, attemptId, input.turnId, input.ownerToken, {
            outcome,
            responseContent: capture.completion ? redactEvidenceContent(JSON.stringify(capture.completion)) : undefined,
            failureCategory: error.category,
            providerStatus: error.status,
            usage: capture.completion?.usage ? { promptTokens: capture.completion.usage.prompt_tokens, completionTokens: capture.completion.usage.completion_tokens, totalTokens: capture.completion.usage.total_tokens, latencyMs: Date.now() - capture.startedAt } : undefined,
          }, correlationId);
          const fallbackAllowed = error.category === 'provider_unavailable' || error.category === 'rate_limited' || error.category === 'model_unavailable';
          lastFailure = error.category === 'ambiguous'
            ? executionError('ambiguous_provider_outcome', correlationId, true, false)
            : error.category === 'provider_unavailable' || error.category === 'rate_limited' || error.category === 'model_unavailable'
              ? executionError('provider_unavailable', correlationId, false, false)
              : executionError('provider_rejected', correlationId, false, false);
          if (fallbackAllowed && hasNext(profileIds, index)) continue;
          break;
        }
        // Adapter/parser/local validation errors never trigger provider substitution.
        await finishAttemptOrThrow(attempts, attemptId, input.turnId, input.ownerToken, { outcome: 'failed', failureCategory: 'adapter_failure', responseContent: capture.completion ? redactEvidenceContent(JSON.stringify(capture.completion)) : undefined }, correlationId);
        throw executionError('provider_rejected', correlationId, false, false);
      }

      await finishAttemptOrThrow(attempts, attemptId, input.turnId, input.ownerToken, {
        outcome: 'succeeded',
        responseContent: capture.completion ? redactEvidenceContent(JSON.stringify(capture.completion)) : safeResponseContent(value),
        usage: capture.completion?.usage ? { promptTokens: capture.completion.usage.prompt_tokens, completionTokens: capture.completion.usage.completion_tokens, totalTokens: capture.completion.usage.total_tokens, latencyMs: Date.now() - capture.startedAt } : undefined,
      }, correlationId);
      if (index === 0) return Object.freeze({ value, effectiveProfileId: profile.id });
      const notice: FallbackNotice = Object.freeze({
        code: 'approved_fallback_used',
        content: 'El servicio seleccionado no está disponible. Continuamos con una alternativa autorizada.',
      });
      try {
        await attempts.recordNotice({ turnId: input.turnId, ownerToken: input.ownerToken, ...notice });
      } catch {
        throw executionError('execution_evidence_unavailable', correlationId, false, false);
      }
      return Object.freeze({ value, effectiveProfileId: profile.id, fallbackNotice: notice });
    }

    throw lastFailure ?? executionError('profile_unavailable', correlationId, false, false);
  }
}

/** Construct one identity-scoped runtime; callers must supply repos-backed factories. */
export function createAiConfigRuntime(
  repositoriesFor: RuntimeRepositoryFactory,
  runtimeIdentity: RuntimeIdentity,
  providers: ProviderRegistry = new ProviderRegistry(),
): AiConfigRuntime {
  return new AiConfigRuntime(repositoriesFor, providers, Object.freeze({ ...runtimeIdentity }));
}

export function assertExecutable(manifest: AiConfigManifestV1, identity: RuntimeIdentity): void {
  const [min, max, current] = [
    parseVersion(manifest.runtimeCompatibility.min),
    parseVersion(manifest.runtimeCompatibility.max),
    parseVersion(identity.runtimeVersion),
  ];
  if (compareVersion(current, min) < 0 || compareVersion(current, max) > 0) throw new Error('Runtime version is outside the frozen compatibility range.');
  // D22: no code/dependency fingerprint gate; those stay in the manifest as provenance only.
}

function applyProfileSettings(
  snapshot: AdapterBehaviorSnapshot,
  purpose: Purpose,
  profile: ModelProfile,
): AdapterBehaviorSnapshot {
  const settings = profile.settings;
  if (Object.keys(settings).some((key) => key !== 'temperature' && key !== 'maxTokens')) {
    throw new ProfileUnavailableError('capability_mismatch');
  }
  if (typeof settings.temperature !== 'number' || !Number.isFinite(settings.temperature)) {
    throw new ProfileUnavailableError('capability_mismatch');
  }
  if (!Number.isSafeInteger(settings.maxTokens) || (settings.maxTokens as number) < 1) {
    throw new ProfileUnavailableError('capability_mismatch');
  }
  if (profile.provider === 'anthropic' && settings.temperature !== 1) {
    throw new ProfileUnavailableError('capability_mismatch');
  }
  const source = snapshot[purpose];
  const effective = Object.freeze({ ...source, temperature: settings.temperature, maxTokens: settings.maxTokens });
  return Object.freeze({ ...snapshot, [purpose]: effective }) as AdapterBehaviorSnapshot;
}

function hasNext(profileIds: readonly string[], index: number): boolean {
  return index + 1 < profileIds.length;
}

function isFallbackEligibleCategory(category: string | null | undefined): boolean {
  return category === 'provider_unavailable' || category === 'rate_limited' || category === 'provider_disabled' ||
    category === 'credential_missing' || category === 'model_unavailable';
}

function executionError(
  category: ExecutionFailureCategory,
  correlationId: string,
  ambiguous: boolean,
  retryable: boolean,
): AiConfigExecutionError {
  return new AiConfigExecutionError(category, correlationId, ambiguous, retryable);
}

async function finishAttemptOrThrow(
  writer: AttemptWriter,
  attemptId: string,
  turnId: string,
  ownerToken: string,
  fields: Parameters<AttemptWriter['finishAttempt']>[0] extends infer Input
    ? Omit<Input & object, 'attemptId' | 'ownerToken' | 'turnId'>
    : never,
  correlationId: string,
): Promise<void> {
  try {
    await writer.finishAttempt({ attemptId, turnId, ownerToken, ...fields });
  } catch {
    throw executionError('execution_evidence_unavailable', correlationId, true, false);
  }
}

function captureAttempt(
  model: ResolvedModel,
  writer: AttemptWriter,
  usage: UsageLedger,
  attemptId: string,
  input: PurposeRunInput,
  capture: { completion?: ChatCompletion; startedAt: number },
  correlationId: string,
  revalidate: () => Promise<boolean>,
): ResolvedModel {
  const original = model.client;
  return Object.freeze({
    ...model,
    client: Object.freeze({
      chat: Object.freeze({
        completions: Object.freeze({
          async create(params: ChatRequest): Promise<ChatCompletion> {
            try {
              await writer.attachAttemptRequest({
                attemptId,
                turnId: input.turnId,
                ownerToken: input.ownerToken,
                requestContent: redactEvidenceContent(JSON.stringify(params)),
              });
            } catch {
              throw executionError('execution_evidence_unavailable', correlationId, false, false);
            }
            let enabled: boolean;
            try {
              enabled = await revalidate();
            } catch {
              throw executionError('execution_evidence_unavailable', correlationId, false, false);
            }
            if (!enabled) throw new ProviderCallError('provider_unavailable');
            capture.startedAt = Date.now();
            return usageGatedCompletion(original, params, usage, {
              provider: model.provider,
              conversationId: input.conversationId,
              turnId: input.turnId,
              attemptId,
            }, (completion) => { capture.completion = completion; });
          },
        }),
      }),
    }),
  });
}

/**
 * THE gated LLM call (KAN-43): reserve, call the provider, settle, then validate the
 * completion. Chat attempts reach it through `captureAttempt`; agent tasks (KAN-31
 * name-agent) through `src/services/llm/agent-completion.ts`, which has no chat turn.
 */
export async function usageGatedCompletion(
  client: ResolvedModel['client'],
  params: ChatRequest,
  usage: UsageLedger,
  correlation: { readonly provider?: string; readonly conversationId?: string; readonly turnId?: string; readonly attemptId?: string; readonly agentTaskId?: string },
  onCompletion?: (completion: ChatCompletion) => void,
): Promise<ChatCompletion> {
  const estimatedCostUsd = estimateLlmCostUsd(params);
  const completion = await runWithUsage(usage, {
    request: { kind: 'llm', estimatedCostUsd, model: params.model, ...correlation },
    call: () => client.chat.completions.create(params),
    actualCost: (result) => llmActualCost(params.model, result.usage) ?? { usd: estimatedCostUsd, source: 'estimate' },
    // A typed non-ambiguous provider failure was not billed; anything else may have been.
    failureCostUsd: (error) => error instanceof ProviderCallError && error.category !== 'ambiguous' ? 0 : estimatedCostUsd,
  });
  onCompletion?.(completion);
  validateProductCompletion(params, completion);
  return completion;
}

function validateProductCompletion(params: ChatRequest, completion: ChatCompletion): void {
  const choice = completion.choices[0];
  if (!choice || choice.finish_reason === 'content_filter' || choice.finish_reason === 'length') {
    throw new ProviderCallError('invalid_response');
  }
  if (params.tools?.length) {
    const requiredName = typeof params.tool_choice === 'object' && params.tool_choice && 'function' in params.tool_choice
      ? params.tool_choice.function.name
      : undefined;
    const toolCall = choice.message.tool_calls?.find((call) => !requiredName || call.function.name === requiredName);
    if (!toolCall) throw new ProviderCallError('invalid_response');
    try {
      const args: unknown = JSON.parse(toolCall.function.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid tool arguments');
    } catch {
      throw new ProviderCallError('invalid_response');
    }
  } else if (typeof choice.message.content !== 'string' || choice.message.content.trim().length === 0) {
    throw new ProviderCallError('invalid_response');
  }
}

function safeResponseContent(value: unknown): string | undefined {
  if (typeof value === 'string') return redactEvidenceContent(value);
  try {
    return redactEvidenceContent(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/** Redact only the persisted evidence copy; the provider receives the original request. */
export function redactEvidenceContent(content: string): string {
  let redacted = content;
  for (const secret of knownSecrets()) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted.replace(
    /\b(?:sk-(?:ant|or|proj)-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/gi,
    '[REDACTED]',
  );
}

function parseVersion(value: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) throw new Error('Unsupported runtime version format.');
  return match.slice(1).map(Number);
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}
