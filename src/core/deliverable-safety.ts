/**
 * MYPES Platform — Recorded output safety verdict (RF-02c / KAN-33)
 * ==================================================================
 *
 * An image service records the minimal safety classifier's result on each
 * output, and the agent handler copies it into the artifact metadata as
 * `metadata.safety` (stored in `deliverables.artifact_metadata`). Decision:
 * `pipeline/decisions/KAN-33-logo-safety-policy.md`.
 *
 * The one rule every reader applies: a deliverable that recorded a verdict
 * other than `passed` is not presentable. Its URL never reaches a client and
 * it cannot be approved. `indeterminate` and a malformed record fail closed.
 * Deliverables without a record (text deliverables, images generated before
 * KAN-33) are unaffected. Pure; no agent- or field-specific branching.
 */

export type SafetyVerdict = 'passed' | 'rejected' | 'indeterminate';

/** `metadata.safety` of a deliverable: the verdict plus the classifier's provenance. */
export interface SafetyRecord {
  readonly verdict: SafetyVerdict;
  /** Why it was rejected (e.g. `sexual_content`); null when passed or indeterminate. */
  readonly category: string | null;
  /** Classifier id, e.g. `fal-safety-checker`. */
  readonly classifier: string;
  /** Model the classified output came from, e.g. `fal-ai/flux-2`. */
  readonly model: string;
  /** Version of the policy that mapped the classifier output to the verdict. */
  readonly policyVersion: string;
  readonly checkedAt: string;
}

/** Version of the verdict mapping in `pipeline/decisions/KAN-33-logo-safety-policy.md`. */
export const SAFETY_POLICY_VERSION = 'logo-safety.v1';

const VERDICTS: ReadonlyArray<SafetyVerdict> = ['passed', 'rejected', 'indeterminate'];

/** The verdict recorded in artifact metadata; null when none was recorded. A malformed record is `indeterminate`. */
export function recordedSafetyVerdict(metadata: unknown): SafetyVerdict | null {
  if (!metadata || typeof metadata !== 'object' || !('safety' in metadata)) return null;
  const verdict = ((metadata as { safety?: unknown }).safety as { verdict?: unknown } | null | undefined)?.verdict;
  return VERDICTS.includes(verdict as SafetyVerdict) ? (verdict as SafetyVerdict) : 'indeterminate';
}

/** False only when the deliverable recorded a verdict other than `passed`. */
export function isPresentable(metadata: unknown): boolean {
  const verdict = recordedSafetyVerdict(metadata);
  return verdict === null || verdict === 'passed';
}
