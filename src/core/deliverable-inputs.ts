/**
 * MYPES Platform — Recorded deliverable inputs (RF-07 / KAN-35)
 * ==============================================================
 *
 * Every candidate keeps stable references to the inputs it was generated
 * from, so staleness is COMPUTED from append-only rows and never written
 * back into history:
 *
 *   - Brief fields: the handler records the fields it actually used in its
 *     artifact metadata, `metadata.inputs = { <field>: { value, version } }`,
 *     where `version` is `inputVersion(value)` (`sha256:<hex>`). The brief has
 *     no per-field version counter, so the fingerprint is the version.
 *   - Upstream approvals: when a command creates a task, the core records the
 *     approved deliverable id of every `mypes:deliverable.dependsOn` kind in
 *     the task's `requirements_snapshot` under `UPSTREAM_SNAPSHOT_KEY`.
 *     Workers strip the key, so it never reaches a handler.
 *   - Upstream values (KAN-32): in the same snapshot, under
 *     `UPSTREAM_INPUTS_KEY`, the approved upstream deliverable's id and its
 *     inline text value. Handlers receive it as `A2AMessage.upstream`; a
 *     handler that uses one records it in `metadata.inputs` with its
 *     `deliverableId`, and such an entry is an upstream reference (trigger
 *     (a)), never compared with the brief.
 *
 * Pure apart from hashing; no agent- or field-specific branching.
 */

import { createHash } from 'node:crypto';

/** `metadata.origin` of a version the user brought instead of generating it (KAN-89, F12). */
export const USER_ORIGIN = 'user';

/** True when the artifact metadata says the user supplied this version. */
export function isUserOrigin(metadata: unknown): boolean {
  return (metadata as { origin?: unknown } | null | undefined)?.origin === USER_ORIGIN;
}

/** Reserved `requirements_snapshot` key: `{ <upstream kind>: <approved deliverable id> }`. */
export const UPSTREAM_SNAPSHOT_KEY = 'upstream_approvals';

/** Reserved `requirements_snapshot` key: `{ <upstream kind>: { deliverableId, value } }` (KAN-32). */
export const UPSTREAM_INPUTS_KEY = 'upstream_inputs';

/** An approved upstream deliverable a handler may read (`A2AMessage.upstream`). */
export interface UpstreamInput {
  readonly deliverableId: string;
  readonly value: string;
}

/** Stable version of a brief value: the same value always yields the same fingerprint. */
export function inputVersion(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** `{ field: version }` from an artifact's `metadata.inputs`, or null when nothing usable was recorded. */
export function recordedFieldVersions(metadata: unknown): Readonly<Record<string, string>> | null {
  const inputs = (metadata as { inputs?: unknown } | null | undefined)?.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null;
  const out: Record<string, string> = {};
  for (const [field, entry] of Object.entries(inputs as Record<string, unknown>)) {
    const { version, deliverableId } = (entry ?? {}) as { version?: unknown; deliverableId?: unknown };
    // An upstream reference is tracked through the task's upstream approvals, not the brief.
    if (typeof version === 'string' && deliverableId === undefined) out[field] = version;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The upstream approvals recorded in a task snapshot, or null for tasks created before KAN-35. */
export function recordedUpstream(snapshot: Readonly<Record<string, unknown>> | null | undefined): Readonly<Record<string, string>> | null {
  const raw = snapshot?.[UPSTREAM_SNAPSHOT_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** The upstream values recorded in a task snapshot; malformed entries are dropped. */
export function recordedUpstreamInputs(
  snapshot: Readonly<Record<string, unknown>> | null | undefined,
): Readonly<Record<string, UpstreamInput>> {
  const raw = snapshot?.[UPSTREAM_INPUTS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([kind, entry]) => {
      const { deliverableId, value } = (entry ?? {}) as { deliverableId?: unknown; value?: unknown };
      return typeof deliverableId === 'string' && typeof value === 'string' ? [[kind, { deliverableId, value }]] : [];
    }),
  );
}

/**
 * Brief fields whose recorded version differs from the current value, sorted.
 * A recorded field that is no longer filled counts as changed; a field the
 * candidate did not use never does.
 */
export function changedFields(
  recorded: Readonly<Record<string, string>>,
  current: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(recorded)
    .filter((field) => {
      const value = current[field];
      const now = typeof value === 'string' && value.trim().length > 0 ? inputVersion(value) : null;
      return now !== recorded[field];
    })
    .sort();
}
