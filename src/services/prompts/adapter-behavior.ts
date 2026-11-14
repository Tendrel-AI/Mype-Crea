/**
 * Rebuilds the extractor/responder `AdapterBehaviorSnapshot` from a frozen prompt file (D22).
 * `assertSupportedAdapterBehavior` stays the structural gate: a version whose renderer/parser ids
 * or template slots this code cannot run is skipped for the active one (logged), never executed.
 */
import {
  assertSupportedAdapterBehavior,
  createCurrentAdapterBehaviorSnapshot,
  type AdapterBehaviorSnapshot,
  type AdapterExecution,
  type AdapterFieldBehavior,
} from '../ai-config/adapter-behavior';
import type { FrozenFile } from '../prompt-ledger/freeze';
import { loggerFor } from '../logger';
import { activePromptVersion, getFrozenPrompt, type PromptVersions } from './index';

const log = loggerFor('services.prompts');

type Purpose = 'extractor' | 'responder';

function fromFrozen(
  purpose: Purpose,
  file: FrozenFile,
  fields: ReadonlyArray<AdapterFieldBehavior>,
  execution?: AdapterExecution,
): AdapterBehaviorSnapshot {
  const base = createCurrentAdapterBehaviorSnapshot(fields);
  const fromExecution = execution?.behavior[purpose];
  const section = {
    ...(file.schema as object),
    promptVersion: file.version,
    promptTemplate: file.text,
    // Profile settings come from the execution. The extractor's field list is always the runtime
    // registry's (the frozen file carries none; the release's list is provenance only).
    ...(fromExecution ? { temperature: fromExecution.temperature, maxTokens: fromExecution.maxTokens } : {}),
    ...(purpose === 'extractor' ? { fields: base.extractor.fields } : {}),
  };
  return { ...base, [purpose]: section } as AdapterBehaviorSnapshot;
}

/** Behavior of the conversation's pinned version, else of the active one; without a pin, the active one. */
export function resolveAdapterBehavior(
  purpose: Purpose,
  pinned: PromptVersions | undefined,
  fields: ReadonlyArray<AdapterFieldBehavior> = [],
  execution?: AdapterExecution,
): AdapterBehaviorSnapshot {
  const active = activePromptVersion(purpose);
  const wanted = pinned?.[purpose];
  for (const version of new Set([wanted, active])) {
    const file = version ? getFrozenPrompt(purpose, version) : undefined;
    if (!file) continue;
    const behavior = fromFrozen(purpose, file, fields, execution);
    try {
      assertSupportedAdapterBehavior(behavior, purpose);
    } catch (err) {
      if (version === active) throw err;
      continue;
    }
    if (wanted && version !== wanted) log.warn({ key: purpose, pinned: wanted, used: version }, 'prompt.pin.fallback');
    return behavior;
  }
  throw new Error(`No usable ${purpose} prompt version (active: ${active || 'none'}).`);
}
