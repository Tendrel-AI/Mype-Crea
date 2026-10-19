import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CONFIDENCE_THRESHOLDS, MAX_FIELD_BATCH_SIZE } from '../../core/contracts';
import type { AdapterFieldBehavior } from './adapter-behavior';
import { createCurrentAdapterBehaviorSnapshot } from './adapter-behavior';
import { ProviderRegistry } from './provider-registry';
import { freezeManifest, validateManifest, type AiConfigManifestV1, type JsonValue } from './manifest';
import logoCard from '../../../agents/logo-agent/agent-card.json';

const SOURCE_FILES = [
  'src/services/ai-config/adapter-behavior.ts',
  'src/services/ai-config/manifest.ts',
  'src/services/ai-config/service.ts',
  'src/services/ai-config/baseline.ts',
  'src/services/ai-config/provider-registry.ts',
  'src/services/ai-config/execution.ts',
  'src/services/llm/types.ts',
  'src/services/llm/model-config.ts',
  'src/services/llm/provider-error.ts',
  'src/services/llm/openrouter-provider.ts',
  'src/services/llm/anthropic-provider.ts',
  'src/services/llm-logger.ts',
  'src/adapters/chat-input-adapter.ts',
  'src/adapters/chat-output-adapter.ts',
  'src/core/orchestrator/bootstrap-registry.ts',
  'src/core/orchestrator/agent-registry.ts',
  'src/core/orchestrator/orchestrator-core.ts',
  'src/core/orchestrator/runtime.ts',
  'agents/logo-agent/handler.ts',
  'src/core/contracts/index.ts',
  'src/core/contracts/decisions.ts',
  'src/core/contracts/deltas.ts',
  'src/core/orchestrator/planner.ts',
  'src/core/orchestrator/merge.ts',
  'app/actions/chat.ts',
];

const CARDS = {
  'logo-agent': logoCard,
} as const;

/** Build a real development/build fingerprint from an internal source allowlist. */
export async function captureSourceIdentity(): Promise<{
  readonly codeFingerprint: string;
  readonly dependencyFingerprint: string;
  readonly sourceContentHashes: Readonly<Record<string, string>>;
}> {
  const sourceContentHashes: Record<string, string> = {};
  const sourceContents: string[] = [];
  const missing: string[] = [];
  for (const relativePath of SOURCE_FILES) {
    try {
      const content = await readFile(resolve(process.cwd(), relativePath), 'utf8');
      sourceContentHashes[relativePath] = sha256(content);
      sourceContents.push(`${relativePath}\0${content}`);
    } catch {
      missing.push(relativePath);
    }
  }

  const cardJson = canonical(CARDS as unknown as JsonValue);
  sourceContentHashes['agent-cards'] = sha256(cardJson);
  const packageLock = await readOptional('package-lock.json');
  if (packageLock) sourceContentHashes['package-lock.json'] = sha256(packageLock);

  if (missing.length > 0 && !process.env.AI_CONFIG_CODE_FINGERPRINT) {
    throw new Error(`Cannot compute a complete code fingerprint; missing source files: ${missing.join(', ')}.`);
  }
  const codeFingerprint = normalizeFingerprint(process.env.AI_CONFIG_CODE_FINGERPRINT ?? sha256(sourceContents.join('\n\n')), 'AI_CONFIG_CODE_FINGERPRINT');
  const dependencyFingerprint = normalizeFingerprint(
    process.env.AI_CONFIG_DEPENDENCY_FINGERPRINT ??
      (packageLock ? sha256(packageLock) : undefined),
    'AI_CONFIG_DEPENDENCY_FINGERPRINT',
  );
  sourceContentHashes['build-code'] = codeFingerprint;
  sourceContentHashes['dependencies'] = dependencyFingerprint;
  return Object.freeze({ codeFingerprint, dependencyFingerprint, sourceContentHashes: Object.freeze(sourceContentHashes) });
}

export async function captureRuntimeIdentity(): Promise<{
  readonly runtimeVersion: string;
  readonly codeFingerprint: string;
  readonly dependencyFingerprint: string;
}> {
  const source = await captureSourceIdentity();
  const runtimeVersion = process.env.AI_CONFIG_RUNTIME_VERSION ?? await readPackageVersion();
  if (!/^\d+\.\d+\.\d+/.test(runtimeVersion)) {
    throw new Error('AI_CONFIG_RUNTIME_VERSION must be a semantic version.');
  }
  return Object.freeze({ runtimeVersion, codeFingerprint: source.codeFingerprint, dependencyFingerprint: source.dependencyFingerprint });
}

/** Capture a complete inert baseline draft. This does not publish, activate, or read credentials. */
export async function createBaselineDraft(): Promise<AiConfigManifestV1> {
  const adapterBehavior = createCurrentAdapterBehaviorSnapshot(readAdapterFields());
  const identity = await captureSourceIdentity();
  const version = process.env.AI_CONFIG_RUNTIME_VERSION ?? await readPackageVersion();
  const plannerHash = identity.sourceContentHashes['src/core/orchestrator/planner.ts'] ?? identity.codeFingerprint;
  const mergeHash = identity.sourceContentHashes['src/core/orchestrator/merge.ts'] ?? identity.codeFingerprint;
  const extractor = adapterBehavior.extractor;
  const responder = adapterBehavior.responder;

  const configuredProvider = process.env.LLM_PROVIDER ?? 'openrouter';
  if (configuredProvider !== 'openrouter' && configuredProvider !== 'anthropic') {
    throw new Error('LLM_PROVIDER must be "openrouter" or "anthropic".');
  }
  const selectedProvider = configuredProvider;
  const extractorModel = selectedProvider === 'anthropic'
    ? process.env.ANTHROPIC_EXTRACTOR_MODEL ?? 'claude-haiku-5-5'
    : process.env.OPENROUTER_EXTRACTOR_MODEL ?? 'google/gemini-2.5-flash';
  const responderModel = selectedProvider === 'anthropic'
    ? process.env.ANTHROPIC_RESPONDER_MODEL ?? 'claude-sonnet-5-5'
    : process.env.OPENROUTER_RESPONDER_MODEL ?? 'google/gemini-2.5-pro';
  const profiles = [
    profile('openrouter-extractor', 'extractor', 'openrouter', 'google/gemini-2.5-flash', 'platform.openrouter', extractor.temperature, extractor.maxTokens, ['forced-tool-call', 'json-schema']),
    profile('anthropic-extractor', 'extractor', 'anthropic', 'claude-haiku-5-5', 'platform.anthropic', 1, extractor.maxTokens, ['forced-tool-call', 'json-schema']),
    profile('openrouter-responder', 'responder', 'openrouter', 'google/gemini-2.5-pro', 'platform.openrouter', responder.temperature, responder.maxTokens, []),
    profile('anthropic-responder', 'responder', 'anthropic', 'claude-sonnet-5-5', 'platform.anthropic', 1, responder.maxTokens, []),
  ];
  for (const candidate of profiles) {
    if (candidate.provider === selectedProvider && candidate.purpose === 'extractor') candidate.model = extractorModel;
    if (candidate.provider === selectedProvider && candidate.purpose === 'responder') candidate.model = responderModel;
  }

  const manifest = validateManifest({
    manifestVersion: 1,
    adapterBehavior,
    agents: CARDS as unknown as Record<string, Record<string, JsonValue>>,
    models: profiles,
    fallback: {
      extractor: selectedProvider === 'anthropic'
        ? { primaryProfileId: 'anthropic-extractor', fallbackProfileIds: ['openrouter-extractor'], maxAttempts: 2 }
        : { primaryProfileId: 'openrouter-extractor', fallbackProfileIds: ['anthropic-extractor'], maxAttempts: 2 },
      responder: selectedProvider === 'anthropic'
        ? { primaryProfileId: 'anthropic-responder', fallbackProfileIds: ['openrouter-responder'], maxAttempts: 2 }
        : { primaryProfileId: 'openrouter-responder', fallbackProfileIds: ['anthropic-responder'], maxAttempts: 2 },
    },
    planner: {
      version: `planner.${plannerHash.slice(0, 16)}`,
      thresholds: {
        confidence: CONFIDENCE_THRESHOLDS as unknown as JsonValue,
        maxFieldBatchSize: MAX_FIELD_BATCH_SIZE,
      },
    },
    merge: { version: `merge.${mergeHash.slice(0, 16)}` },
    runtimeCompatibility: { min: version, max: version },
    snapshot: {
      code: `sha256:${identity.codeFingerprint}`,
      dependencies: `sha256:${identity.dependencyFingerprint}`,
      sourceContentHashes: identity.sourceContentHashes,
    },
    externalRefs: { git: null, langsmith: null },
  });
  const providers = new ProviderRegistry();
  for (const profile of manifest.models) providers.assertProfileSupported(profile, profile.purpose);
  return manifest;
}

/** Hash helper shared with release diagnostics; output never contains source contents. */
export function fingerprintManifest(manifest: AiConfigManifestV1): string {
  return freezeManifest(manifest).contentHash;
}

function readAdapterFields(): AdapterFieldBehavior[] {
  const merged = new Map<string, { name: string; required: boolean; promptHint: string; agents: string[] }>();
  for (const [agentId, rawCard] of Object.entries(CARDS)) {
    const card = rawCard as unknown as Record<string, unknown>;
    const requirements = card['mypes:requirements'] as { required?: Array<Record<string, unknown>>; optional?: Array<Record<string, unknown>> };
    for (const [required, fields] of [[true, requirements.required ?? []], [false, requirements.optional ?? []]] as const) {
      for (const field of fields) {
        if (typeof field.name !== 'string' || typeof field.promptHint !== 'string') continue;
        const existing = merged.get(field.name);
        if (existing) {
          existing.required ||= required;
          existing.agents.push(agentId);
        } else {
          merged.set(field.name, { name: field.name, required, promptHint: field.promptHint, agents: [agentId] });
        }
      }
    }
  }
  return [...merged.values()]
    .map((field) => ({ ...field, agents: [...new Set(field.agents)].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function profile(
  id: string,
  purpose: 'extractor' | 'responder',
  provider: 'openrouter' | 'anthropic',
  model: string,
  credentialRef: string,
  temperature: number,
  maxTokens: number,
  capabilities: readonly string[],
) {
  return { id, purpose, provider, model, modelRevision: null, credentialRef, capabilities, settings: { temperature, maxTokens } };
}

function normalizeFingerprint(value: string | undefined, variable: string): string {
  if (!value) throw new Error(`${variable} is required when source files are unavailable.`);
  const fingerprint = value.replace(/^sha256:/i, '');
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Error(`${variable} must be a SHA-256 hex fingerprint.`);
  return fingerprint.toLowerCase();
}

async function readOptional(relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(resolve(process.cwd(), relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

async function readPackageVersion(): Promise<string> {
  const raw = await readOptional('package.json');
  if (!raw) throw new Error('AI_CONFIG_RUNTIME_VERSION is required when package.json is unavailable.');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error('package.json does not provide a runtime version.');
  return parsed.version;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
