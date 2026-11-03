# KAN-70 adapter execution contract

This is the adapter-level seam only. It does not provide identity resolution, release persistence,
conversation pinning, fallback, turn recovery, admin UI, or trace durability.

## Public types

`src/services/ai-config/adapter-behavior.ts` exports:

- `AdapterBehaviorSnapshot`: JSON-serializable behavior for both chat stages.
- `AdapterExecution`: `{ model: ResolvedModel; behavior: AdapterBehaviorSnapshot }` for one
  purpose-specific adapter invocation.
- `createCurrentAdapterBehaviorSnapshot(fields?)`: current behavior baseline, optionally bound to
  the registry's merged field set.
- `assertSupportedAdapterBehavior(behavior, purpose)`: runtime compatibility and required
  guardrail checks before a provider call.

`ExtractInput.execution` and `RenderInput.execution` are optional. Omitting them preserves the
existing environment-selected singleton path used by older callers, tests, and evals. Product
composition should resolve and pass the frozen per-call execution explicitly. The adapters never
mutate process environment or swap the global provider.

## Frozen content and compatibility

The extractor snapshot contains its prompt template/version, renderer/parser versions, forced tool
name/description/choice, exact field schema template, registry fields with requiredness/hints/agent
owners, temperature/token limit, confirmation fast-path version, and empty-history policy. The
adapter compares the snapshot's field entries with the runtime registry and the rendered frozen
tool schema with the parser's generated JSON Schema before invoking the provider.

The responder snapshot contains its system template, all static prompt fragments used by the
renderer, prompt/renderer/parser versions, temperature/token limit, and history policy/limit. Its
neutral Spanish, tuteo, and no-voseo guardrails are mandatory. It renders from the supplied frozen
template and fragments. A zero history limit means no prior messages.

The current extractor prompt is `extractor.v5` (KAN-26 added the product brief fields); the Responder remains
`responder.chat-step1.v5`. Renderer/parser version labels describe executable code compatibility;
they do not make old code available after a deployment. Unknown versions fail before provider
invocation. Runtime registry matching checks the extractor field schema and hints: every frozen field must exist in the runtime registry unchanged (name, required, hint, owners); the registry may declare more fields (KAN-26), and the extractor asks the model only for the frozen ones. Matching full
Agent Card bytes and card compatibility remain release/composition responsibilities.

## Limits

This seam does not authorize the caller or prove that the selected model credential is permitted.
It does not persist a behavior snapshot, choose a release, reserve attempts, pin a conversation,
or guarantee that a retry will not repeat a provider charge. Those responsibilities remain for
the KAN-70 manifest, identity, controller, persistence, and execution-resolver work.
