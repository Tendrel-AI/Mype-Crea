# KAN-54 — Peruvian legal review packet (regulatory labelling agent)

Status: **prepared — review not yet requested**

- Nobody has been contacted and nothing has been sent. KAN-54 requires the owner's specific
  authorization before any third party is contacted. Reusing an existing review counts if it
  covers the scope below. "La ausencia local no prueba ausencia externa".
- Purpose: to give qualified Peruvian lawyers one self-contained brief. The review must be
  recorded before any pilot participant can use the regulatory agent (P0663; KAN-54 AC).
- Blocked by KAN-39 and KAN-40 (Jira). The review must cover the versions that will actually be
  exposed. Request it after those versions exist, or scope it explicitly to a stated version.

## 1. What the system does (for the reviewer)

CreaMype is a conversational assistant that helps Peruvian micro and small processed-food
businesses (MYPE) prepare brand and pre-launch deliverables. The regulatory part (Phase 1) does
four things:

| Ticket | Behavior | Nature of output |
|---|---|---|
| KAN-36 (RF-03) | Drafts label text from the user's brief: name, ingredients (generic name + INS code), allergens, storage conditions, manufacturer details, and a **placeholder** for the registro sanitario | Referential proposal. It never invents missing critical data and asks the user instead. |
| KAN-37 (SYS-04) | The user enters nutrient values from their own laboratory analysis per 100 g / 100 ml and the front-panel size, then confirms each critical value explicitly | User-declared data; the system does not verify it |
| KAN-38 (RF-04) | A deterministic rule engine (no AI model) compares the confirmed values with the thresholds in KAN-50 and returns the octagon set, the reason for each octagon, and its position and size | Reproducible computation tied to a rule-set version |
| KAN-39 (RF-05) / KAN-40 (SYS-05) | Composes the front label with the official warnings and checks minimum fields plus the literal «verificar con DIGESA» | Referential design and automatic checklist. Neither is a certification. |

Thesis commitments the review should test: outputs are "propuesta referencial … nunca como
certificación de cumplimiento" (P0305). Each output carries "el disclaimer «verificar con
DIGESA»" and the norms it relied on (P0311, P0313). Personal data is processed under Ley 29733
with informed consent and data minimization (P0576).

## 2. Scope of the review

1. **System behavior** in section 1, including what happens when data is missing, values are
   edited after confirmation, or the engine returns `needs_review` (for example, trans fats; see
   KAN-50 PA-02).
2. **Referential nature of outputs.** Is presenting proposals "nunca como certificación de
   cumplimiento" enough to avoid the outputs being read as professional advice or certification?
3. **DIGESA verification notice.** Wording, placement, and frequency (section 3).
4. **Data protection (Ley 29733).** Consent and terms of use for the data the regulatory flow
   collects: business identity, product composition, and laboratory results. Also purpose,
   storage, non-disclosure, and minimization (P0576).
5. **Responsibility allocation** between the platform, the institutional tenant (pilot
   partner), and the MYPE owner who prints or sells the label.
6. **Out of scope:** substantive regulatory correctness of thresholds and label fields. That is
   the competent technical review in the KAN-50 sign-off. The lawyers may comment on it, but
   their sign-off does not replace it.

## 3. Proposed user-facing wording (for review; neutral Latin-American Spanish, tuteo)

| Where | Proposed text |
|---|---|
| Every label proposal (KAN-36/39) | «Esta etiqueta es una propuesta referencial y no certifica el cumplimiento de la normativa. Antes de imprimirla o venderla, debes verificar con DIGESA.» |
| Octagon result (KAN-38) | «Calculamos estas advertencias con los valores que confirmaste y con las reglas vigentes a la fecha indicada. Si cambias algún valor, volveremos a calcularlas. El resultado no reemplaza la revisión de DIGESA.» |
| Before confirming critical values (KAN-37) | «Revisa que cada valor coincida con tu análisis de laboratorio. Tú eres responsable de los datos que confirmas.» |
| Consent (Ley 29733) | «Usaremos los datos de tu negocio y de tu producto solo para preparar tus entregables. No los compartiremos con terceros. Puedes pedir su eliminación cuando quieras.» |

The literal string «verificar con DIGESA» is a hard requirement (KAN-36, KAN-40). Its surrounding
sentence may change.

## 4. Questions for the reviewers

1. Does the platform, by producing label text and octagon determinations for third parties,
   take on any duty or liability under Peruvian law (for example consumer protection or
   professional-service rules)? Does the referential disclaimer limit it effectively?
2. Is the wording in section 3 adequate and unambiguous? Should it name the user's own duty to
   obtain the registro sanitario and comply with Ley 30021, DS 017-2017-SA, and DS 012-2018-SA?
3. Where must the notice appear: on screen, embedded in the downloadable artwork, or both? Can a
   notice embedded in the artwork be removed by the user without consequence for the platform?
4. Does showing a registro sanitario **placeholder** create any risk of misleading third parties?
   Is there preferred placeholder wording?
5. If the engine is wrong (for example, a missing octagon), who bears the consequences, given the
   disclaimer, the user's confirmation of each value, and the institutional pilot context? Are
   specific terms of use clauses needed?
6. Is the current consent model (explicit acceptance of terms stating purpose, storage, and
   non-disclosure) sufficient under Ley 29733 and its Reglamento for laboratory results and
   business data? Is registration of a *banco de datos personales* or another formality required?
7. Do the pilot partner (institutional tenant) and the platform need a data-processing agreement
   for this flow?
8. MYPE adhesives (Ley 31919; DS 017-2023-SA §8.5): may the platform recommend or produce
   adhesive octagon artwork, and with what caveats?
9. Do any of the KAN-50 pending items (PA-01 boundary semantics, PA-02 trans fats, PA-04 draft
   parameter update) make it legally inadvisable to expose the engine before they are resolved?
10. Should the agent refuse to produce a label for categories it cannot classify (KAN-50
    R-SCOPE-02..05) instead of returning a referential proposal?
11. What conditions, if any, must be met before participants may use the agent, and what
    evidence should we keep to show they were met?

## 5. Artifacts and versions to review

Fill in commit hashes and versions when the review is requested. The review covers exactly these
versions. Any later change to them requires re-confirming the review.

| Artifact | Location | Version / commit |
|---|---|---|
| KAN-50 regulatory rules spec | `pipeline/regulatory/KAN-50-regulatory-rules-spec.md` | `kan50-rules-0.1-draft` · commit ____ · competent sign-off: pending |
| KAN-36 label text agent | code + agent card (to be linked) | ____ |
| KAN-37 nutrient input and confirmation | ____ | ____ |
| KAN-38 octagon engine | ____ | ____ |
| KAN-39 front-label composer | ____ | ____ |
| KAN-40 minimum-field checklist | ____ | ____ |
| KAN-68 gate policy (Option B, approved 2026-11-02) | `pipeline/decisions/KAN-68-regulatory-gate-policy.md` | ____ |
| Terms of use and consent text | ____ | ____ |
| Sample outputs (3–5 anonymized proposals, including one `needs_review`) | ____ | ____ |

## 6. Exposure gate

- **Participants stay blocked from the regulatory agent until this review is signed off and its
  required changes are closed.** This holds even if CI is green: a passing golden set (KAN-59,
  KAN-68) is technical evidence, not legal approval.
- Today only `logo-agent` is live for the pilot tenant, so the regulatory agent is not exposed.
  Whatever mechanism later enables it for participants must check that a KAN-54 record with
  outcome "approved" or "approved with changes, all closed" exists for the deployed versions.
- If the KAN-48 institutional review is adopted, it is an additional gate and does not replace
  this one.
- The release checklist (KAN-49) links the signed record below and its exposure decision.

## 7. Review record (template)

```
Review ID:
Reviewer(s) name:
Firm / institution:
Colegio de Abogados / registration:
Engagement authorized by owner on (date, reference):
Date review requested:
Date review completed:
Artifacts and versions reviewed (section 5 table, filled):
Outcome:                         approved / approved with changes / rejected
Answers to section 4 questions (or reference to the opinion document):
Required changes (one per line: ID, description, owner, ticket):
Closure of each required change (ID → commit/evidence, date, verified by):
Exposure decision:               participants may use the regulatory agent: yes / no
Conditions on exposure:
Evidence location (authorized storage):
Linked from release checklist (KAN-49): yes / no
```

## 8. Closure criteria (KAN-54 Definition of Done)

- A signed record exists in an authorized location and covers the section 5 versions.
- Every required change is closed with evidence, and the exposure authorization is recorded.
- The release checklist links the record. While any condition is open, KAN-54 stays open and
  participant access stays blocked.
