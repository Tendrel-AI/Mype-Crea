import { createHash } from 'node:crypto';
import { defaultTenantKeyService, type TenantKeyService } from '../openrouter/tenant-keys';
import { loggerFor } from '../logger';
import type { ILLMProvider, ModelPurpose, ProviderModelIds, ResolvedModel } from '../llm/types';
import { AnthropicProvider } from '../llm/anthropic-provider';
import { OpenRouterProvider } from '../llm/openrouter-provider';
import { isAnthropicModelId, isOpenRouterModelId } from '../llm/model-config';
import type { ModelProfile, Purpose } from './manifest';

const log = loggerFor('service.provider-registry');
const TENANT_KEY_TTL_MS = 60_000;

export type ProfileUnavailableReason = 'provider_disabled' | 'credential_missing' | 'model_unavailable' | 'model_unsupported' | 'capability_mismatch';

export class ProfileUnavailableError extends Error {
  constructor(readonly reason: ProfileUnavailableReason) {
    super(`AI profile is unavailable: ${reason}.`);
    this.name = 'ProfileUnavailableError';
  }
}

export interface TrustedModelCapabilities {
  readonly forcedToolCall: boolean;
  readonly jsonSchemaTool: boolean;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportedOptions: readonly ('temperature' | 'max_tokens' | 'tools' | 'tool_choice')[];
}

export interface ProviderCacheContext {
  readonly tenantId: string;
  readonly releaseId: string;
  readonly profileId: string;
}

type CredentialResolver = (credentialRef: string) => string | undefined;
type ProviderFactory = (
  provider: ModelProfile['provider'],
  apiKey: string,
  modelIds: ProviderModelIds,
) => ILLMProvider;

const ALLOWED_CREDENTIAL_REFS: Readonly<Record<ModelProfile['provider'], string>> = {
  openrouter: 'platform.openrouter',
  anthropic: 'platform.anthropic',
};

/**
 * Explicit provider/model resolver. It never reads LLM_PROVIDER and never mutates process.env.
 * The capability catalog is platform-owned code, not the manifest's self-declared capabilities.
 */
/** Env kill switch `AI_CONFIG_<PROVIDER>_ENABLED`. Throws on a malformed value. */
export function isProviderEnvEnabled(provider: ModelProfile['provider']): boolean {
  const setting = process.env[`AI_CONFIG_${provider.toUpperCase()}_ENABLED`];
  if (setting !== undefined && setting !== '' && setting !== 'true' && setting !== 'false') {
    throw new Error(`AI_CONFIG_${provider.toUpperCase()}_ENABLED must be "true" or "false".`);
  }
  return setting !== 'false';
}

export class ProviderRegistry {
  private readonly clients = new Map<string, ILLMProvider>();
  private readonly tenantKeys = new Map<string, { key: string | undefined; at: number }>();

  constructor(
    private readonly credentialResolver: CredentialResolver = resolvePlatformCredential,
    private readonly providerFactory: ProviderFactory = createProvider,
    private readonly capabilityResolver: (profile: ModelProfile) => TrustedModelCapabilities | undefined = trustedCapabilities,
    private readonly tenantKeyService: () => Pick<TenantKeyService, 'resolveKey' | 'scheduleSync'> | null = defaultTenantKeyService,
  ) {}

  /**
   * D36: load the tenant's OpenRouter sub-key (when it has one) so the sync `resolve` can use it.
   * Fails open to the platform key: attribution is lost, the ledger still debits the tenant.
   */
  async warmTenantKey(tenantId: string): Promise<void> {
    const cached = this.tenantKeys.get(tenantId);
    if (cached && Date.now() - cached.at < TENANT_KEY_TTL_MS) return;
    let key: string | undefined;
    try {
      key = await this.tenantKeyService()?.resolveKey(tenantId);
    } catch (err) {
      log.error({ tenantId, err: err instanceof Error ? err.name : 'unknown' }, 'tenant_key.resolve_failed');
    }
    this.tenantKeys.set(tenantId, { key, at: Date.now() });
  }

  /** After a provider call: keep the tenant's key limit mirrored to its balance (throttled, never throws). */
  noteCall(tenantId: string, provider: ModelProfile['provider']): void {
    if (provider === 'openrouter' && this.tenantKeys.get(tenantId)?.key) this.tenantKeyService()?.scheduleSync(tenantId);
  }

  assertProfileSupported(profile: ModelProfile, purpose: Purpose): void {
    if (profile.purpose !== purpose) throw new ProfileUnavailableError('capability_mismatch');
    const trusted = this.capabilityResolver(profile);
    if (!trusted) throw new ProfileUnavailableError('model_unsupported');
    if (purpose === 'extractor' && (!trusted.forcedToolCall || !trusted.jsonSchemaTool)) {
      throw new ProfileUnavailableError('capability_mismatch');
    }
    if (Object.keys(profile.settings).some((key) => key !== 'temperature' && key !== 'maxTokens')) {
      throw new ProfileUnavailableError('capability_mismatch');
    }
    const temperature = profile.settings.temperature;
    const maxTokens = profile.settings.maxTokens;
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) ||
      !Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > trusted.maxOutputTokens ||
      (profile.provider === 'anthropic' && temperature !== 1)) {
      throw new ProfileUnavailableError('capability_mismatch');
    }
  }

  resolve(profile: ModelProfile, purpose: Purpose, context: ProviderCacheContext): ResolvedModel {
    this.assertProfileSupported(profile, purpose);
    if (!isProviderEnvEnabled(profile.provider)) {
      throw new ProfileUnavailableError('provider_disabled');
    }
    const trusted = this.capabilityResolver(profile)!;
    if (profile.credentialRef !== ALLOWED_CREDENTIAL_REFS[profile.provider]) {
      throw new ProfileUnavailableError('credential_missing');
    }
    const tenantKey = profile.provider === 'openrouter' ? this.tenantKeys.get(context.tenantId)?.key : undefined;
    const apiKey = (tenantKey ?? this.credentialResolver(profile.credentialRef))?.trim();
    if (!apiKey) throw new ProfileUnavailableError('credential_missing');

    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const cacheKey = [
      context.tenantId,
      context.releaseId,
      context.profileId,
      profile.purpose,
      profile.provider,
      profile.model,
      profile.credentialRef,
      keyHash,
    ].join(':');
    let provider = this.clients.get(cacheKey);
    if (!provider) {
      provider = this.providerFactory(profile.provider, apiKey, { [purpose]: profile.model });
      this.clients.set(cacheKey, provider);
    }
    const resolved = provider.resolve(purpose);
    return Object.freeze({
      ...resolved,
      client: wrapProfileClient(resolved.client, profile, trusted),
      modelId: profile.model,
      purpose,
      provider: profile.provider,
      modelRevision: profile.modelRevision ?? undefined,
    });
  }

  /** Availability is based only on configured platform credentials and an explicit disable flag. */
  isPlatformAvailable(provider: ModelProfile['provider']): boolean {
    if (!isProviderEnvEnabled(provider)) return false;
    return Boolean(this.credentialResolver(ALLOWED_CREDENTIAL_REFS[provider])?.trim());
  }
}

function resolvePlatformCredential(credentialRef: string): string | undefined {
  if (credentialRef === ALLOWED_CREDENTIAL_REFS.openrouter) return process.env.OPENROUTER_API_KEY;
  if (credentialRef === ALLOWED_CREDENTIAL_REFS.anthropic) return process.env.ANTHROPIC_API_KEY;
  return undefined;
}

function createProvider(
  provider: ModelProfile['provider'],
  apiKey: string,
  modelIds: ProviderModelIds,
): ILLMProvider {
  return provider === 'openrouter'
    ? new OpenRouterProvider(apiKey, modelIds)
    : new AnthropicProvider(apiKey, modelIds);
}

function trustedCapabilities(profile: ModelProfile): TrustedModelCapabilities | undefined {
  const known = profile.provider === 'openrouter'
    ? new Set(['google/gemini-2.5-flash', 'google/gemini-2.5-pro'])
    : new Set(['claude-haiku-5-5', 'claude-sonnet-5-5']);
  const validId = profile.provider === 'openrouter'
    ? isOpenRouterModelId(profile.model)
    : isAnthropicModelId(profile.model);
  if (!validId || !known.has(profile.model)) return undefined;
  return {
    forcedToolCall: profile.provider === 'openrouter' || profile.model === 'claude-haiku-5-5',
    jsonSchemaTool: profile.provider === 'openrouter' || profile.model === 'claude-haiku-5-5',
    contextWindowTokens: profile.provider === 'openrouter' ? 1_048_576 : 1_000_000,
    maxOutputTokens: profile.provider === 'openrouter' ? 65_536 : 128_000,
    supportedOptions: ['temperature', 'max_tokens', 'tools', 'tool_choice'],
  };
}

function wrapProfileClient(
  client: ResolvedModel['client'],
  profile: ModelProfile,
  capabilities: TrustedModelCapabilities,
): ResolvedModel['client'] {
  const allowed = new Set(capabilities.supportedOptions);
  return {
    chat: {
      completions: {
        create(params) {
          if (params.model !== profile.model) throw new Error('Request model differs from the frozen profile.');
          const temperature = profile.settings.temperature;
          const maxTokens = profile.settings.maxTokens;
          if (typeof temperature !== 'number' || params.temperature !== temperature) {
            throw new Error('Request temperature differs from the frozen profile settings.');
          }
          if (profile.provider === 'anthropic' && temperature !== 1) {
            throw new ProfileUnavailableError('capability_mismatch');
          }
          if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || params.max_tokens !== maxTokens) {
            throw new Error('Request max_tokens differs from the frozen profile settings.');
          }
          if ((params.max_tokens ?? 0) > capabilities.maxOutputTokens) {
            throw new ProfileUnavailableError('capability_mismatch');
          }
          const requestBytes = Buffer.byteLength(JSON.stringify({ messages: params.messages, tools: params.tools }), 'utf8');
          if (requestBytes + (params.max_tokens ?? 0) > capabilities.contextWindowTokens) {
            throw new ProfileUnavailableError('capability_mismatch');
          }
          for (const field of ['temperature', 'max_tokens', 'tools', 'tool_choice'] as const) {
            if (params[field] !== undefined && !allowed.has(field)) {
              throw new Error(`Frozen profile does not support request option ${field}.`);
            }
          }
          if (profile.purpose === 'extractor') {
            if (!capabilities.forcedToolCall || !capabilities.jsonSchemaTool || !params.tools?.length || params.tool_choice === undefined) {
              throw new ProfileUnavailableError('capability_mismatch');
            }
          }
          return client.chat.completions.create(params).catch((error: unknown) => {
            if (error instanceof Error && error.name === 'ProviderCallError' && 'category' in error &&
              (error as { category?: unknown }).category === 'model_unavailable') {
              throw new ProfileUnavailableError('model_unavailable');
            }
            throw error;
          });
        },
      },
    },
  };
}
