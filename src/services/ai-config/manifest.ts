import { createHash } from 'node:crypto';
import {
  assertSupportedAdapterBehavior,
  type AdapterBehaviorSnapshot,
} from './adapter-behavior';

/** JSON value allowed in a portable, non-executable AI configuration manifest. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Purpose = 'extractor' | 'responder';
export type ProviderId = 'openrouter' | 'anthropic';

export interface ModelProfile {
  readonly id: string;
  readonly purpose: Purpose;
  readonly provider: ProviderId;
  readonly model: string;
  readonly modelRevision: string | null;
  /** Opaque lookup key only. It must never contain a credential value. */
  readonly credentialRef: string;
  readonly capabilities: readonly string[];
  readonly settings: Readonly<Record<string, JsonValue>>;
}

export interface PurposeFallback {
  readonly primaryProfileId: string;
  /** Ordered fallback profile IDs; an empty list explicitly means no fallback. */
  readonly fallbackProfileIds: readonly string[];
  /** Configured ceiling for all primary + fallback attempts for this purpose. */
  readonly maxAttempts: number;
}

export interface AiConfigManifestV1 {
  readonly manifestVersion: 1;
  readonly adapterBehavior: AdapterBehaviorSnapshot;
  readonly agents: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  readonly models: readonly ModelProfile[];
  readonly fallback: Readonly<Record<Purpose, PurposeFallback>>;
  readonly planner: Readonly<{ version: string; thresholds: Readonly<Record<string, JsonValue>> }>;
  readonly merge: Readonly<{ version: string }>;
  readonly runtimeCompatibility: Readonly<{ min: string; max: string }>;
  readonly snapshot: Readonly<{
    code: string;
    dependencies: string;
    sourceContentHashes: Readonly<Record<string, string>>;
  }>;
  readonly externalRefs: Readonly<{
    git: Readonly<{ repository: string; commit: string } | null>;
    langsmith: Readonly<{ prompt: string; commit: string } | null>;
  }>;
}

export interface FrozenManifest {
  readonly content: AiConfigManifestV1;
  readonly contentHash: string;
}

export interface ManifestDiffEntry {
  readonly path: string;
  readonly before: JsonValue | undefined;
  readonly after: JsonValue | undefined;
}

const REQUIRED_CAPABILITIES: Record<Purpose, readonly string[]> = {
  extractor: ['forced-tool-call', 'json-schema'],
  responder: [],
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SECRET_VALUE = /(?:\bsk-(?:ant|or|proj)-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b)/i;

function fail(path: string, message: string): never {
  throw new Error(`Invalid AI config manifest at ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required field is missing');
}

function requiredString(value: unknown, path: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.trim() === '' || (pattern && !pattern.test(value))) {
    fail(path, 'expected a non-empty valid string');
  }
  return value;
}

function assertSafeJson(value: unknown, path = '$', ancestors = new Set<object>()): asserts value is JsonValue {
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) fail(path, 'recognizable credential material is forbidden');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'non-finite numbers are not JSON');
    return;
  }
  if (typeof value !== 'object') fail(path, 'expected JSON data');
  if (ancestors.has(value)) fail(path, 'cyclic content is not allowed');
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length) fail(path, 'symbol keys are not JSON');
    if (Object.keys(value).some((key) => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      fail(path, 'arrays cannot have non-index properties');
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail(`${path}[${index}]`, 'sparse arrays are not JSON');
      assertSafeJson(value[index], `${path}[${index}]`, ancestors);
    }
  }
  else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(path, 'expected a plain JSON object');
    if (Object.getOwnPropertySymbols(value).length) fail(path, 'symbol keys are not JSON');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !('value' in descriptor)) fail(path, 'JSON object properties must be enumerable data properties');
    }
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail(`${path}.${key}`, 'prototype keys are not allowed');
      if (/(?:secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential)(?!ref)/i.test(key)) {
        fail(`${path}.${key}`, 'secret-bearing field names are forbidden; use an opaque credentialRef');
      }
      assertSafeJson(child, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function validateModelId(provider: ProviderId, model: string, path: string): void {
  const valid = provider === 'openrouter' ? /^[^/\s]+\/[^/\s]+$/.test(model) : /^claude-[a-z0-9][a-z0-9-]*$/i.test(model);
  if (!valid) fail(path, `malformed ${provider} model ID`);
}

/** Validate and clone JSON content into a deeply immutable v1 manifest. */
export function validateManifest(input: unknown): AiConfigManifestV1 {
  assertSafeJson(input);
  if (!isRecord(input)) fail('$', 'expected an object');
  exactKeys(input, ['manifestVersion', 'adapterBehavior', 'agents', 'models', 'fallback', 'planner', 'merge', 'runtimeCompatibility', 'snapshot', 'externalRefs'], '$');
  if (input.manifestVersion !== 1) fail('$.manifestVersion', 'unsupported manifest version');

  const behavior = input.adapterBehavior;
  if (!isRecord(behavior)) fail('$.adapterBehavior', 'full adapter behavior snapshot is required');
  exactKeys(behavior, ['schemaVersion', 'extractor', 'responder'], '$.adapterBehavior');
  if (behavior.schemaVersion !== 'adapter-behavior.v1') fail('$.adapterBehavior.schemaVersion', 'unsupported adapter behavior version');
  for (const purpose of ['extractor', 'responder'] as const) {
    const p = behavior[purpose];
    if (!isRecord(p)) fail(`$.adapterBehavior.${purpose}`, 'frozen behavior section is required');
    const stageFields = purpose === 'extractor'
      ? ['promptVersion', 'promptTemplate', 'rendererVersion', 'parserVersion', 'temperature', 'maxTokens', 'toolName', 'toolDescription', 'toolChoice', 'fieldSchemaTemplate', 'fields', 'fastPathVersion', 'historyPolicyVersion']
      : ['promptVersion', 'promptTemplate', 'rendererVersion', 'parserVersion', 'temperature', 'maxTokens', 'historyLimit', 'historyPolicyVersion', 'promptFragments'];
    exactKeys(p, stageFields, `$.adapterBehavior.${purpose}`);
    for (const field of ['promptVersion', 'rendererVersion', 'parserVersion', 'historyPolicyVersion']) requiredString(p[field], `$.adapterBehavior.${purpose}.${field}`, ID);
    requiredString(p.promptTemplate, `$.adapterBehavior.${purpose}.promptTemplate`);
    if (typeof p.temperature !== 'number' || !Number.isFinite(p.temperature)) fail(`$.adapterBehavior.${purpose}.temperature`, 'finite generation setting required');
    if (!Number.isSafeInteger(p.maxTokens) || (p.maxTokens as number) < 1) fail(`$.adapterBehavior.${purpose}.maxTokens`, 'positive generation setting required');
  }
  const extractor = behavior.extractor as Record<string, unknown>;
  requiredString(extractor.toolName, '$.adapterBehavior.extractor.toolName', ID);
  requiredString(extractor.toolDescription, '$.adapterBehavior.extractor.toolDescription');
  if (!isRecord(extractor.toolChoice)) fail('$.adapterBehavior.extractor.toolChoice', 'frozen tool choice required');
  exactKeys(extractor.toolChoice, ['type', 'function'], '$.adapterBehavior.extractor.toolChoice');
  if (extractor.toolChoice.type !== 'function' || !isRecord(extractor.toolChoice.function)) fail('$.adapterBehavior.extractor.toolChoice', 'forced function choice required');
  exactKeys(extractor.toolChoice.function, ['name'], '$.adapterBehavior.extractor.toolChoice.function');
  if (extractor.toolChoice.function.name !== extractor.toolName) fail('$.adapterBehavior.extractor.toolChoice.function.name', 'must match toolName');
  if (!isRecord(extractor.fieldSchemaTemplate) || Object.keys(extractor.fieldSchemaTemplate).length === 0) fail('$.adapterBehavior.extractor.fieldSchemaTemplate', 'frozen tool output schema is required');
  if (extractor.fieldSchemaTemplate.$schema !== 'http://json-schema.org/draft-07/schema#') {
    fail('$.adapterBehavior.extractor.fieldSchemaTemplate.$schema', 'supported output schema dialect must be frozen');
  }
  if (!Array.isArray(extractor.fields)) fail('$.adapterBehavior.extractor.fields', 'frozen field and Agent Card hint list required');
  for (const [index, field] of extractor.fields.entries()) {
    const path = `$.adapterBehavior.extractor.fields[${index}]`;
    if (!isRecord(field)) fail(path, 'expected field behavior object');
    exactKeys(field, ['name', 'required', 'promptHint', 'agents'], path);
    requiredString(field.name, `${path}.name`, ID); requiredString(field.promptHint, `${path}.promptHint`);
    if (typeof field.required !== 'boolean') fail(`${path}.required`, 'expected boolean');
    if (!Array.isArray(field.agents) || field.agents.some((agent) => typeof agent !== 'string' || !ID.test(agent))) fail(`${path}.agents`, 'expected agent IDs');
  }
  const fieldNames = (extractor.fields as Array<Record<string, unknown>>).map((field) => field.name);
  if (new Set(fieldNames).size !== fieldNames.length) fail('$.adapterBehavior.extractor.fields', 'duplicate field name');
  requiredString(extractor.fastPathVersion, '$.adapterBehavior.extractor.fastPathVersion', ID);
  const responder = behavior.responder as Record<string, unknown>;
  if (!Number.isSafeInteger(responder.historyLimit) || (responder.historyLimit as number) < 0) fail('$.adapterBehavior.responder.historyLimit', 'configured history limit required');
  if (!isRecord(responder.promptFragments) || Object.keys(responder.promptFragments).length === 0) {
    fail('$.adapterBehavior.responder.promptFragments', 'frozen responder prompt fragments are required');
  }
  for (const [fragmentId, fragment] of Object.entries(responder.promptFragments)) {
    requiredString(fragmentId, '$.adapterBehavior.responder.promptFragments key', ID);
    requiredString(fragment, `$.adapterBehavior.responder.promptFragments.${fragmentId}`);
  }
  try {
    assertSupportedAdapterBehavior(input.adapterBehavior as unknown as AdapterBehaviorSnapshot, 'extractor');
    assertSupportedAdapterBehavior(input.adapterBehavior as unknown as AdapterBehaviorSnapshot, 'responder');
  } catch (error) {
    fail('$.adapterBehavior', error instanceof Error ? error.message : 'unsupported adapter behavior');
  }

  if (!isRecord(input.agents) || Object.keys(input.agents).length === 0) fail('$.agents', 'full Agent Card content is required');
  for (const [agentId, card] of Object.entries(input.agents)) {
    requiredString(agentId, `$.agents key`, ID);
    if (!isRecord(card) || Object.keys(card).length === 0) fail(`$.agents.${agentId}`, 'full Agent Card content is required');
    requiredString(card.name, `$.agents.${agentId}.name`);
    requiredString(card.description, `$.agents.${agentId}.description`);
    requiredString(card.version, `$.agents.${agentId}.version`, ID);
  }
  for (const [index, field] of (extractor.fields as Array<Record<string, unknown>>).entries()) {
    for (const agentId of field.agents as string[]) {
      if (!Object.hasOwn(input.agents, agentId)) fail(`$.adapterBehavior.extractor.fields[${index}].agents`, `unknown Agent Card ${agentId}`);
    }
  }
  if (!Array.isArray(input.models) || input.models.length < 2) fail('$.models', 'one primary profile per purpose is required');
  const profiles = new Map<string, ModelProfile>();
  input.models.forEach((raw, index) => {
    const path = `$.models[${index}]`;
    if (!isRecord(raw)) fail(path, 'expected a profile object');
    exactKeys(raw, ['id', 'purpose', 'provider', 'model', 'modelRevision', 'credentialRef', 'capabilities', 'settings'], path);
    const id = requiredString(raw.id, `${path}.id`, ID);
    if (profiles.has(id)) fail(`${path}.id`, 'duplicate profile ID');
    if (raw.purpose !== 'extractor' && raw.purpose !== 'responder') fail(`${path}.purpose`, 'unsupported purpose');
    if (raw.provider !== 'openrouter' && raw.provider !== 'anthropic') fail(`${path}.provider`, 'unsupported provider');
    const model = requiredString(raw.model, `${path}.model`);
    validateModelId(raw.provider, model, `${path}.model`);
    if (raw.modelRevision !== null) requiredString(raw.modelRevision, `${path}.modelRevision`, ID);
    const credentialRef = requiredString(raw.credentialRef, `${path}.credentialRef`, OPAQUE_REF);
    if (SECRET_VALUE.test(credentialRef)) fail(`${path}.credentialRef`, 'credentialRef must be opaque, not a credential value');
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some((cap) => typeof cap !== 'string' || !ID.test(cap))) fail(`${path}.capabilities`, 'expected capability IDs');
    if (!isRecord(raw.settings)) fail(`${path}.settings`, 'expected a settings object');
    profiles.set(id, raw as unknown as ModelProfile);
  });

  const fallback = input.fallback;
  if (!isRecord(fallback)) fail('$.fallback', 'expected an object');
  exactKeys(fallback, ['extractor', 'responder'], '$.fallback');
  const used = new Set<string>();
  for (const purpose of ['extractor', 'responder'] as const) {
    const f = fallback[purpose];
    if (!isRecord(f)) fail(`$.fallback.${purpose}`, 'expected an object');
    exactKeys(f, ['primaryProfileId', 'fallbackProfileIds', 'maxAttempts'], `$.fallback.${purpose}`);
    const primaryId = requiredString(f.primaryProfileId, `$.fallback.${purpose}.primaryProfileId`, ID);
    const primary = profiles.get(primaryId);
    if (!primary || primary.purpose !== purpose) fail(`$.fallback.${purpose}.primaryProfileId`, 'profile missing or has wrong purpose');
    if (!Number.isSafeInteger(f.maxAttempts) || (f.maxAttempts as number) < 1 || (f.maxAttempts as number) > 2) {
      fail(`$.fallback.${purpose}.maxAttempts`, 'configured attempt count must be one or two');
    }
    if (!Array.isArray(f.fallbackProfileIds)) fail(`$.fallback.${purpose}.fallbackProfileIds`, 'expected ordered array');
    const chain = [primaryId, ...f.fallbackProfileIds.map((x) => requiredString(x, `$.fallback.${purpose}.fallbackProfileIds`, ID))];
    if (chain.length > (f.maxAttempts as number)) fail(`$.fallback.${purpose}`, 'attempt ceiling is lower than configured chain length');
    if (new Set(chain).size !== chain.length) fail(`$.fallback.${purpose}.fallbackProfileIds`, 'fallback cycle or duplicate profile');
    for (const profileId of chain) {
      const profile = profiles.get(profileId);
      if (!profile || profile.purpose !== purpose) fail(`$.fallback.${purpose}`, `unknown or incompatible profile ${profileId}`);
      for (const capability of REQUIRED_CAPABILITIES[purpose]) if (!profile.capabilities.includes(capability)) fail(`$.models.${profileId}.capabilities`, `missing required ${purpose} capability ${capability}`);
      if (used.has(profileId)) fail(`$.fallback.${purpose}`, 'profile appears in multiple purpose chains');
      used.add(profileId);
    }
  }
  if (used.size !== profiles.size) fail('$.models', 'every profile must occur in exactly one explicit purpose chain');

  if (!isRecord(input.planner)) fail('$.planner', 'expected an object');
  exactKeys(input.planner, ['version', 'thresholds'], '$.planner');
  requiredString(input.planner.version, '$.planner.version', ID);
  if (!isRecord(input.planner.thresholds) || !Object.keys(input.planner.thresholds).length) fail('$.planner.thresholds', 'frozen thresholds required');
  if (!isRecord(input.merge)) fail('$.merge', 'expected an object');
  exactKeys(input.merge, ['version'], '$.merge'); requiredString(input.merge.version, '$.merge.version', ID);
  if (!isRecord(input.runtimeCompatibility)) fail('$.runtimeCompatibility', 'expected an object');
  exactKeys(input.runtimeCompatibility, ['min', 'max'], '$.runtimeCompatibility');
  const minVersion = requiredString(input.runtimeCompatibility.min, '$.runtimeCompatibility.min', SEMVER);
  const maxVersion = requiredString(input.runtimeCompatibility.max, '$.runtimeCompatibility.max', SEMVER);
  const minParts = minVersion.split(/[.+-]/).slice(0, 3).map(Number);
  const maxParts = maxVersion.split(/[.+-]/).slice(0, 3).map(Number);
  const minAfterMax = minParts.some((part, index) => part > maxParts[index] && minParts.slice(0, index).every((prior, priorIndex) => prior === maxParts[priorIndex]));
  if (minAfterMax) fail('$.runtimeCompatibility', 'minimum runtime version exceeds maximum');
  if (!isRecord(input.snapshot)) fail('$.snapshot', 'expected an object');
  exactKeys(input.snapshot, ['code', 'dependencies', 'sourceContentHashes'], '$.snapshot');
  requiredString(input.snapshot.code, '$.snapshot.code');
  requiredString(input.snapshot.dependencies, '$.snapshot.dependencies');
  if (!isRecord(input.snapshot.sourceContentHashes) || Object.keys(input.snapshot.sourceContentHashes).length === 0) {
    fail('$.snapshot.sourceContentHashes', 'at least one supplied source content hash is required');
  }
  for (const [key, hash] of Object.entries(input.snapshot.sourceContentHashes)) {
    requiredString(key, '$.snapshot.sourceContentHashes key');
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
      fail(`$.snapshot.sourceContentHashes.${key}`, 'expected SHA-256 hex digest');
    }
  }
  if (!isRecord(input.externalRefs)) fail('$.externalRefs', 'expected an object');
  exactKeys(input.externalRefs, ['git', 'langsmith'], '$.externalRefs');
  const git = input.externalRefs.git;
  if (git !== null) {
    if (!isRecord(git)) fail('$.externalRefs.git', 'expected object or null');
    exactKeys(git, ['repository', 'commit'], '$.externalRefs.git');
    const repository = requiredString(git.repository, '$.externalRefs.git.repository');
    if (!/^https:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repository)) {
      fail('$.externalRefs.git.repository', 'expected a portable HTTPS Git repository URL');
    }
    requiredString(git.commit, '$.externalRefs.git.commit', /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i);
  }
  const ls = input.externalRefs.langsmith;
  if (ls !== null) {
    if (!isRecord(ls)) fail('$.externalRefs.langsmith', 'expected object or null');
    exactKeys(ls, ['prompt', 'commit'], '$.externalRefs.langsmith');
    requiredString(ls.prompt, '$.externalRefs.langsmith.prompt', ID);
    requiredString(ls.commit, '$.externalRefs.langsmith.commit', /^[a-f0-9]{8,64}$/i);
  }

  return deepFreeze(cloneJson(input) as unknown as AiConfigManifestV1);
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneJson(v)])) as T;
  return value;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function canonicalizeManifestJson(value: JsonValue): string {
  assertSafeJson(value);
  return canonical(value);
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`).join(',')}}`;
  if (typeof value === 'number') return postgresJsonNumber(value);
  return JSON.stringify(value);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** PostgreSQL jsonb numeric output is decimal; expand JS exponent notation before hashing. */
function postgresJsonNumber(value: number): string {
  const encoded = JSON.stringify(value);
  if (!/[eE]/.test(encoded)) return encoded;
  const [coefficient, exponentText] = encoded.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [integer, fraction = ''] = unsigned.split('.');
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  const expanded = decimalIndex <= 0
    ? `0.${'0'.repeat(-decimalIndex)}${digits}`
    : decimalIndex >= digits.length
      ? `${digits}${'0'.repeat(decimalIndex - digits.length)}`
      : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return `${negative ? '-' : ''}${expanded}`;
}

export function freezeManifest(input: unknown): FrozenManifest {
  const content = validateManifest(input);
  return Object.freeze({ content, contentHash: createHash('sha256').update(canonical(content as unknown as JsonValue)).digest('hex') });
}

export function diffManifests(before: unknown, after: unknown): readonly ManifestDiffEntry[] {
  const a = validateManifest(before) as unknown as JsonValue;
  const b = validateManifest(after) as unknown as JsonValue;
  const result: ManifestDiffEntry[] = [];
  const walk = (left: JsonValue | undefined, right: JsonValue | undefined, path: string): void => {
    if (left !== undefined && right !== undefined && isRecord(left) && isRecord(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(left[key] as JsonValue | undefined, right[key] as JsonValue | undefined, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    } else if (left !== undefined && right !== undefined && canonical(left) === canonical(right)) return;
    else result.push(Object.freeze({ path: path || '/', before: left, after: right }));
  };
  walk(a, b, '');
  return Object.freeze(result);
}

/** Parse imported JSON as inert data, validate it and return its content identity. */
export function importManifest(serialized: string): FrozenManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized) as unknown; } catch { throw new Error('Invalid AI config manifest import: malformed JSON'); }
  return freezeManifest(parsed);
}

/** Export only validated frozen content; output is canonical JSON, never executable code. */
export function exportManifest(input: unknown): string {
  const content = validateManifest(input);
  return canonical(content as unknown as JsonValue);
}
