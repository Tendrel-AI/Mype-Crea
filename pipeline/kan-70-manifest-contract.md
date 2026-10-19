# KAN-70 frozen manifest contract (v1)

`src/services/ai-config/manifest.ts` is a pure domain module. It performs no I/O, provider
calls, credential lookup, health check, or code execution. Imported content remains inert JSON.

The exported `AiConfigManifestV1` freezes:

- `adapterBehavior`, the `adapter-behavior.v1` snapshot supplied by the adapter boundary. It
  includes both prompt templates and versions, renderer/parser versions, generation settings,
  extractor tool choice and full output-schema template/fast-path version, and responder history
  policy/limit plus the exact prompt fragment catalog used to render decision and guardrail text.
- `agents`, containing full Agent Card objects including prompt hints and schema-affecting data.
- `models`, with purpose-scoped provider/model/revision, opaque `credentialRef`, capabilities,
  and provider settings. Credentials and secret-bearing property names are rejected recursively.
- `fallback`, with an explicit primary and ordered fallback profile IDs for each purpose plus a
  configured `maxAttempts` ceiling of one or two. The product policy is at most the original
  attempt plus one fallback. Extractor profiles must declare forced-tool-call and JSON-schema
  capability. Profiles cannot cross purpose chains or be duplicated in a chain.
- planner version and frozen thresholds, merge version, runtime compatibility bounds, supplied
  code/dependency and source-content hash identities, and nullable pinned Git/LangSmith commits.

`validateManifest(unknown)` rejects malformed, unsupported, incomplete, cyclic, non-JSON, or
unknown-field content and returns a cloned deeply frozen manifest. `freezeManifest(unknown)` also
returns its canonical SHA-256 content hash. Canonicalization sorts object keys recursively and
preserves array order. A content edit therefore changes the hash while key insertion order does
not.

`diffManifests(before, after)` validates both inputs and returns JSON-pointer paths with before/
after values. `importManifest(serialized)` parses JSON as inert data and validates/freezes it;
`exportManifest(input)` emits canonical validated JSON. Import/export do not resolve profiles or
execute prompt templates.

The schema deliberately requires each profile chain's explicit attempt ceiling and assigns no
cost, retention, or token budget. Capability declarations are configuration claims and do not
replace trusted provider/runtime capability validation. Runtime authorization, credential
existence, current provider availability, tenant permission, and adapter/runtime compatibility
remain separate checks at their owning boundaries.
