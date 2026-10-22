# KAN-68 — Gate policy for regulatory discrepancies

Status: proposed — awaiting owner approval

## Context

- **Blocks:** KAN-59 (verify invariants and octagons against reference and boundary cases).
  KAN-59 is also blocked by KAN-50 (versioned, reviewed regulatory rules), KAN-35, KAN-38, and
  KAN-39. The gate is applied in the KAN-14 CI. Related: KAN-54 (Peruvian legal review before any
  participant reaches the regulatory agent), KAN-48 (optional institutional review, scope TBD).
- **The thesis contradicts itself:**
  - **P0436 (RNF-08 metric):** "100 % de coincidencia entre la salida del sistema y el conjunto
    dorado de casos. Cualquier discrepancia se considera fallo bloqueante." P0466 weights RNF-08
    highest (16 %) because a failure has direct legal consequences (Ley 30021).
  - **P0773 (CI plan):** "Nocturno / por release: evaluación de la determinación de octógonos
    contra el conjunto dorado (**no bloqueante**, con seguimiento de métricas en el tiempo)".
  - **P0771:** on every push/PR, pre-merge table-driven tests of the octagon engine's
    deterministic logic. P0602: golden-set verification in CI is a completion criterion.
- **KAN-68 AC:** present both references and record a decision for PR, nightly, and release. Keep
  the 100 % requirement against an *approved* reference, and do not lower requirements by
  inference.
- **Current reality:** no octagon engine or regulatory suite exists yet (KAN-59). CI
  (`.github/workflows/ci.yml`, `pipeline/kan-61-ci-policy.md`) runs lint, typecheck, unit tests,
  build, migrations, and the RLS check on `developer` PRs and pushes. Paid LLM evals never run
  automatically. **Branch protection / required checks are unverified**, so no check currently
  *blocks* a merge.

## Decision needed

1. Is a golden-set discrepancy blocking at PR, nightly, and/or release?
2. How is a discrepancy resolved: code fix vs. reference change? Who may change the reference?
3. How does the CI gate relate to the legal exposure gate (KAN-54)?

## Options

**A. Literal P0773: nightly/release, non-blocking, trend only.** This contradicts P0436 and the
KAN-68 AC ("no rebajar requisitos"). A wrong octagon could reach `main` and auto-deploy (P0772).
Not acceptable for the regulatory engine.

**B. Blocking everywhere for the deterministic suite (recommended).** The octagon determination
and composition are pure and LLM-free, so the full approved golden set is cheap enough to run on
**every PR and push** (P0771) as a required check. The same suite re-runs nightly and at release.
A nightly failure opens a defect and **blocks release** until fixed. P0773's "non-blocking,
trend-tracked" wording is scoped to suites that are stochastic or costly: label-text LLM evals,
extractor evals, and heavy reconnection tests. Those keep trend reporting under separate budget
authorization. This reconciles both anchors without lowering RNF-08. It also extends the
deterministic-core claim: regulatory decisions are exact and gate the build, as the planner does.

**C. Blocking only at release, informational on PRs.** This makes development faster, because a
contributor can merge an in-progress rule change. Defects surface late, `developer` can carry a
wrong determination for days, and evidence that `main` always satisfied RNF-08 is lost. It is
weaker than B with little benefit, since the suite is fast.

## Recommendation

**Option B**, plus these discrepancy rules:

- **Approved vs. candidate cases.** Only cases with KAN-50 rule provenance and a recorded
  specialist review count toward the 100 %. Candidate (unreviewed) cases run and are reported,
  but never block and never count toward the pass rate.
- **No silent exits.** Approved cases cannot be skipped, quarantined, or marked expected-fail. A
  discrepancy is fixed in code, or the *reference* changes through a versioned golden-set change
  that cites the KAN-50 rule version and its reviewer. The change must not be authored by the
  same person who changed the engine in that PR.
- **Comparison target.** Compare structured outputs (octagon set, positions/dimensions/
  proportions as numbers) exactly. Do not compare rendered pixels, which would make the gate
  flaky.
- **Separate gates.** A green CI run is technical evidence only. Exposing the regulatory agent to
  pilot participants additionally requires the KAN-54 legal sign-off, and KAN-48 institutional
  review if it is adopted. Neither is implied by this record.

## Consequences / follow-up tickets

- Owner action: make the regulatory job a **required status check** on `developer` and `main`
  (branch protection). Until then, "blocking" is a policy that is not enforced.
- KAN-59 creates the suite with an approved/candidate split. KAN-14 adds the job, a nightly
  workflow, and release gating. KAN-50 defines the golden-set provenance format.
- Release checklist (KAN-49) links the green run, golden-set version, and KAN-54 decision.

## Open questions for the owner

1. Approve Option B (deterministic golden set blocking on PR, nightly, and release; P0773
   non-blocking applies only to LLM/heavy suites)?
2. Who is the specialist reviewer allowed to approve golden-set cases and reference changes?
   This needs regulatory expertise (relates to KAN-50/KAN-54), not only engineering.
3. Will you enable branch protection with required checks on `developer` and `main`?
