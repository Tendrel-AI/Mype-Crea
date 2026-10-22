# KAN-76 — Content blocks, data, and styles for a structured landing page

Status: proposed — awaiting owner approval

## Context

- **Ticket:** KAN-76 (React 5/5, in progress). Its first work item is to agree with product on the
  set of blocks, data, and styles a structured landing supports, and record that decision before
  adapting producer, transport, and persistence. The latest Jira comment (merge `3c87332`) says
  the typed contract, validator, and React renderer are on `developer`. The optional
  `landingPageContent` prop is never produced, so the pilot is unchanged. The ticket is blocked
  on this product confirmation.
- **Already implemented** (`src/landing-page/contract.ts`, `docs/ui/landing-page-content-contract.md`):
  `{ format: 'typed', schemaVersion: 1, sections: [...] }` with five kinds: `hero` (heading,
  text, optional image URL, optional CTA), `benefits` (heading/body pairs), `gallery` (image URL,
  alt, caption), `callToAction` (heading, text, label, URL), and `contact` (methods/links). It
  contains plain text only, absolute `http(s)` URLs only, and no style fields. Unknown kinds are
  ignored, and invalid sections are dropped. Legacy HTML (`format: 'legacy-html'`) renders only in
  a `sandbox="allow-scripts"` iframe.
- **Scope tension with the thesis:** P0612 lists among the Phase 1 exclusions "agente constructor
  de páginas web ni presencia digital continua". KAN-51 also excludes "sitios web" from the
  Phase 1 prototype. The legacy wizard still shows a "Web" step (architecture §1). How steps 2–5
  move onto the orchestrator is a separate **TBD with user** that this record does not resolve.
- **Asset references:** once KAN-52 lands, logos and labels live in a private bucket behind
  **expiring signed URLs**. A landing payload that stores raw URLs would break when they expire.
  Today's fal.ai URLs may also expire (§2.15).
- **Content risk:** a `benefits` block for a processed-food product can easily contain nutrition
  or health claims, which Peruvian rules regulate (Ley 30021/DIGESA, P0558). Generated claims would
  need the same legal treatment as label copy (KAN-54).

## Decision needed

1. Which section kinds are in schema v1, and is v1 frozen?
2. Which data do sections carry: free URLs or references to approved deliverables?
3. Which style controls, if any, exist?
4. Is a landing producer in Phase 1 scope at all?

## Options

**A. Approve the implemented five-section v1 as-is.** There is no new work. Raw URLs and the
missing brand styling remain, and so do the asset-expiry and claims risks above.

**B. Brand-sheet set derived from approved deliverables.** Sections: `hero` (business name,
tagline, logo), `product` (label image + short description), `contact`. Images use
`assetRef: { deliverableId }`, resolved to a fresh signed URL at render time, instead of stored
URLs. Content comes from approved deliverables (KAN-65), so there is almost nothing new to
generate or legally review. A `theme` block uses only validated hex colors from the approved brand
palette plus a font pairing from a fixed allowlist, with no free CSS. Size: small–medium (schema
v2, renderer, resolver).

**C. Richer marketing set.** A plus pricing, testimonials, FAQ, map, social links, and a full
theme. It is the most expressive option, but testimonials and benefits invite fabricated or
regulated claims. It needs a generator, legal review, and more validation, which is out of Phase 1
scope per P0612.

**D. Freeze and defer.** Keep the current v1 contract and legacy iframe as-is, record that no
landing producer exists in Phase 1 (P0612), and close KAN-76 at "contract + renderer, no
producer". Revisit the block set when a Phase 2 web agent is scoped.

Deterministic-planner impact: none for A, B, and D. In C, a landing generator would be a new agent
behind the same planner and transport, which is not a Phase 1 concern.

## Recommendation

**D now, with B as the designated v2 direction.** Keep schema v1 frozen and do not build a
producer, persistence change, or transport change in Phase 1, because the thesis excludes web
builders. In the contract doc, record that a future v2 will (a) reference approved deliverables
by ID instead of raw URLs, (b) add only a constrained `theme` (palette hex + font allowlist, no
CSS), and (c) treat any generated benefit/claim text as regulated copy that requires KAN-54-style
review. For the legacy "Web" step, show it as unavailable, for example: «La página web estará
disponible más adelante.» Do not hide it silently.

## Consequences / follow-up tickets

- Update `docs/ui/landing-page-content-contract.md` status from "pending" to the approved option.
  Close or re-scope KAN-76 accordingly.
- If B is chosen now instead: a schema v2 ticket, an asset-reference resolver (depends on
  KAN-52), and approved-deliverable inputs (depends on KAN-65).
- Wizard steps 2–5 migration stays a separate decision (architecture §1 TBD).

## Open questions for the owner

1. Is any landing page in Phase 1 scope, given the P0612 exclusion? If not, approve Option D.
2. If yes, which set do you want: the current five sections (A), or the brand sheet (B)?
3. Style controls: none, or a constrained palette/font theme?
4. What should the legacy "Web" step show during the pilot: «disponible más adelante», hidden, or
   as it is today?
