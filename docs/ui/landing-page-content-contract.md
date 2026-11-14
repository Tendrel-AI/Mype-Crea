# Landing page content contract

Status: default first-version UI contract for KAN-76. User confirmation of the proposed
section set was requested and is still pending; revise this contract if the user changes it.

## First-version typed content

Represent newly supplied landing-page content as versioned structured data, not an HTML
string. Use a top-level discriminator such as `schemaVersion: 1` and an ordered `sections`
array. Version 1 supports these section kinds:

- `hero`: heading, supporting text, optional image URL, and optional call-to-action label/link.
- `benefits`: heading and an ordered list of benefit heading/body pairs.
- `gallery`: heading and an ordered list of image URL, alt text, and optional caption entries.
- `callToAction`: heading, supporting text, label, and destination URL.
- `contact`: heading and the available contact methods/links.

Content fields are plain text. Render them as React text/attributes so markup is never
interpreted as HTML. Validate the payload against its versioned schema before rendering.
Validate every URL field as an absolute `http:` or `https:` URL; reject other schemes,
protocol-relative URLs, and malformed values. Optional invalid media/link values are omitted;
invalid required values make that section invalid. Preserve section order and ignore unknown
section kinds safely so a newer payload cannot break the page.

## Legacy HTML and discrimination

Existing saved/generated HTML remains a legacy representation and is rendered only in an
iframe with `sandbox="allow-scripts"`; never add `allow-same-origin`. Keep legacy and typed
content distinguishable with an explicit format/schema discriminator (for example,
`format: "legacy-html"` versus `format: "typed"` plus `schemaVersion`). For records without a
discriminator, treat the existing HTML field as legacy for compatibility; do not infer typed
content by parsing HTML. New typed payloads must carry their discriminator and schema version.

## Accessibility and client-facing copy

Use semantic section landmarks/headings in a logical order, meaningful image alt text (empty
alt only for decorative images), descriptive link labels, and visible keyboard focus. Preserve
adequate text contrast and do not convey meaning by color alone. Any UI labels, errors, or
default copy shown to customers must be neutral Latin-American Spanish with tuteo and no
voseo, consistent with the repository language rule.

## Acceptance limits and scope

Acceptance for this contract is limited to: five supported typed section kinds; versioned,
validated typed data rendered as React content; validated URL fields; legacy HTML isolated in
the sandboxed iframe described above; and the accessibility/copy requirements in this doc.
It does not require a producer, persistence migration, editing workflow, publishing, responsive
design beyond the existing UI baseline, or a live landing-page agent. No landing-page producer
is live today.

This is a UI/content contract only. It does not resolve the **TBD with user** decision in
`docs/agents/architecture.md` about how wizard steps 2–5 migrate onto the orchestrator, or decide
which agents or orchestration flows will produce these sections. The existing UI baseline's
legacy iframe behavior remains the compatibility reference.
