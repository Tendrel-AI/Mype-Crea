# Graph Report - .  (2026-05-11)

## Corpus Check
- 0 files · ~0 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 949 nodes · 1685 edges · 91 communities (61 shown, 30 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 44 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Chat Action & Server Entry|Chat Action & Server Entry]]
- [[_COMMUNITY_Agent Handlers & A2A Transport|Agent Handlers & A2A Transport]]
- [[_COMMUNITY_Lifecycle & Artifact Notifiers|Lifecycle & Artifact Notifiers]]
- [[_COMMUNITY_Agent Registry & A2A Cards|Agent Registry & A2A Cards]]
- [[_COMMUNITY_IDs, FieldDeltas & Decision Notifier|IDs, FieldDeltas & Decision Notifier]]
- [[_COMMUNITY_Image Generation Service|Image Generation Service]]
- [[_COMMUNITY_Agent Tasks Repository|Agent Tasks Repository]]
- [[_COMMUNITY_Orchestrator Design Rationale|Orchestrator Design Rationale]]
- [[_COMMUNITY_High-Level Architecture Doc|High-Level Architecture Doc]]
- [[_COMMUNITY_Integration Test Harness|Integration Test Harness]]
- [[_COMMUNITY_Test Fixtures & Builders|Test Fixtures & Builders]]
- [[_COMMUNITY_Provider Singletons (ImageLLM)|Provider Singletons (Image/LLM)]]
- [[_COMMUNITY_Planner Decision Variants|Planner Decision Variants]]
- [[_COMMUNITY_Chat Input Adapter (Extractor)|Chat Input Adapter (Extractor)]]
- [[_COMMUNITY_Conversation & Field Contracts|Conversation & Field Contracts]]
- [[_COMMUNITY_RLS & Persistence Rationale|RLS & Persistence Rationale]]
- [[_COMMUNITY_Chat Output Adapter (Responder)|Chat Output Adapter (Responder)]]
- [[_COMMUNITY_LLM Provider Test Hooks|LLM Provider Test Hooks]]
- [[_COMMUNITY_Orchestrator Core Pipeline|Orchestrator Core Pipeline]]
- [[_COMMUNITY_CreaMype Wizard Component|CreaMype Wizard Component]]
- [[_COMMUNITY_App Layout & Error Boundary|App Layout & Error Boundary]]
- [[_COMMUNITY_Domain Error Types|Domain Error Types]]
- [[_COMMUNITY_Orchestrator Core Dependencies|Orchestrator Core Dependencies]]
- [[_COMMUNITY_OpenRouter LLM Provider|OpenRouter LLM Provider]]
- [[_COMMUNITY_Planner Internals|Planner Internals]]
- [[_COMMUNITY_RLS Migration Strategy|RLS Migration Strategy]]
- [[_COMMUNITY_In-Memory Conversation Store|In-Memory Conversation Store]]
- [[_COMMUNITY_Agent Registry Entries|Agent Registry Entries]]
- [[_COMMUNITY_Agent Registry Methods|Agent Registry Methods]]
- [[_COMMUNITY_Wizard SSE Integration|Wizard SSE Integration]]
- [[_COMMUNITY_Testing Conventions|Testing Conventions]]
- [[_COMMUNITY_Smoke Scripts & Identity Resolution|Smoke Scripts & Identity Resolution]]
- [[_COMMUNITY_ESLint Configuration|ESLint Configuration]]
- [[_COMMUNITY_Migration Extensions|Migration: Extensions]]
- [[_COMMUNITY_Migration App Schema & Helpers|Migration: App Schema & Helpers]]
- [[_COMMUNITY_Migration Messages Table|Migration: Messages Table]]
- [[_COMMUNITY_Migration LLM Calls Table|Migration: LLM Calls Table]]
- [[_COMMUNITY_Migration Agent States Column|Migration: Agent States Column]]
- [[_COMMUNITY_Migration Conversations Table|Migration: Conversations Table]]
- [[_COMMUNITY_Migration Agent Tasks Table|Migration: Agent Tasks Table]]
- [[_COMMUNITY_Migration Tenants & Users|Migration: Tenants & Users]]
- [[_COMMUNITY_Migration Deliverables Table|Migration: Deliverables Table]]
- [[_COMMUNITY_Repo Smoke Script|Repo Smoke Script]]
- [[_COMMUNITY_cn() Utility|cn() Utility]]
- [[_COMMUNITY_Skill Documents|Skill Documents]]
- [[_COMMUNITY_Prompt Injection Defense Rationale|Prompt Injection Defense Rationale]]
- [[_COMMUNITY_Next.js Type Declarations|Next.js Type Declarations]]
- [[_COMMUNITY_Cross-Tenant Isolation Test|Cross-Tenant Isolation Test]]
- [[_COMMUNITY_ESLint Inheritance Note|ESLint Inheritance Note]]
- [[_COMMUNITY_Echo-Path Smoke Test|Echo-Path Smoke Test]]
- [[_COMMUNITY_Message UI Type|Message UI Type]]
- [[_COMMUNITY_MAX_FIELD_BATCH_SIZE Constant|MAX_FIELD_BATCH_SIZE Constant]]
- [[_COMMUNITY_InvalidDeltaError|InvalidDeltaError]]
- [[_COMMUNITY_AgentNotRegisteredError|AgentNotRegisteredError]]
- [[_COMMUNITY_TaskNotFoundError|TaskNotFoundError]]
- [[_COMMUNITY_CrossTenantAccessError|CrossTenantAccessError]]
- [[_COMMUNITY_newConversationId Factory|newConversationId Factory]]
- [[_COMMUNITY_newDeliverableId Factory|newDeliverableId Factory]]
- [[_COMMUNITY_getChatInputAdapter Singleton|getChatInputAdapter Singleton]]
- [[_COMMUNITY_getChatOutputAdapter Singleton|getChatOutputAdapter Singleton]]
- [[_COMMUNITY_closePool Singleton|closePool Singleton]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]

## God Nodes (most connected - your core abstractions)
1. `loggerFor()` - 28 edges
2. `Repos` - 23 edges
3. `ConversationId` - 23 edges
4. `UUID` - 22 edges
5. `TaskId` - 21 edges
6. `AgentRegistry` - 18 edges
7. `AgentId` - 17 edges
8. `Database Skill — schema, isolation, access rules` - 16 edges
9. `SystemRepos` - 10 edges
10. `PlannerDecision` - 10 edges

## Surprising Connections (you probably didn't know these)
- `InputAdapter / OutputAdapter modality abstraction` --implements--> `CreaMype client component (monolithic UI)`  [INFERRED]
  claude/skills/mypes-architecture/SKILL.md → components/CreaMype.tsx
- `Responder SSE per-turn streaming` --implements--> `CreaMype client component (monolithic UI)`  [INFERRED]
  claude/skills/mypes-architecture/SKILL.md → components/CreaMype.tsx
- `Artifact Streaming via SSE` --references--> `GET /api/agents/stream`  [EXTRACTED]
  CLAUDE.md → app/api/agents/stream/route.ts
- `Server Actions as Controllers` --references--> `chatAction`  [EXTRACTED]
  CLAUDE.md → app/actions/chat.ts
- `PILOT_TENANT_ID env var` --references--> `Home Page (server shell)`  [INFERRED]
  CLAUDE.md → app/page.tsx

## Communities (91 total, 30 thin omitted)

### Community 0 - "Chat Action & Server Entry"
Cohesion: 0.05
Nodes (52): signOutAction(), chatAction(), ChatActionResult, log, BrandAssets, CreaMypeProps, EMPTY_ASSETS, Message (+44 more)

### Community 1 - "Agent Handlers & A2A Transport"
Cohesion: 0.05
Nodes (39): DeliverableId, newTaskId(), buildFixtureCard(), buildSingleAgentFixtureRegistry(), FixtureCardOptions, mergeFieldDelta(), child, InProcessDecisionNotifier (+31 more)

### Community 2 - "Lifecycle & Artifact Notifiers"
Cohesion: 0.05
Nodes (49): InProcessAgentLifecycleNotifier, IAgentLifecycleNotifier, AgentCard, AgentRegistry, A2AArtifact, A2AMessage, A2ATaskResult, AgentHandler (+41 more)

### Community 3 - "Agent Registry & A2A Cards"
Cohesion: 0.07
Nodes (26): ConversationId, AgentTaskProcessingEvent, IAgentLifecycleNotifier, InProcessAgentLifecycleNotifier, ArtifactPublishedEvent, IArtifactNotifier, InProcessArtifactNotifier, log (+18 more)

### Community 4 - "IDs, FieldDeltas & Decision Notifier"
Cohesion: 0.08
Nodes (25): FalImageProvider, log, ImageGeneratorService, log, getImageGenerator(), resetImageGenerator(), setImageGenerator(), IImageGenerator (+17 more)

### Community 5 - "Image Generation Service"
Cohesion: 0.07
Nodes (41): assertJsonbTenantSafe, agentTasksRepo.claimById, agentTasksRepo.claimNextPending, agentTasksRepo.insertRoot, agent_tasks repository (integration), agentTasksRepo, buildDefaultRegistry, getConversationOwnerUserId (+33 more)

### Community 6 - "Agent Tasks Repository"
Cohesion: 0.08
Nodes (30): AgentRequirementState, ConversationSnapshot, FieldSlot, OrchestratorCore, AnnounceAllCompleteDecision, AnnounceCompletionDecision, AnnounceDispatchDecision, ConfirmFieldDecision (+22 more)

### Community 7 - "Orchestrator Design Rationale"
Cohesion: 0.08
Nodes (27): buildGuardrails(), buildResponderSystemPrompt(), ChatOutputAdapter, describeAnnounceCompletion(), describeDecision(), describeDecisions(), describeFieldStatus(), log (+19 more)

### Community 8 - "High-Level Architecture Doc"
Cohesion: 0.07
Nodes (32): Atomic claim via SELECT FOR UPDATE SKIP LOCKED, Tests reference CONFIDENCE_THRESHOLDS constants, not magic numbers, DB-as-queue with Redis Pub/Sub wake-up, Thesis claim: decision layer deterministic over extracted state, Acknowledged dual-write failure (Postgres commit, Redis publish fails), Four-layer cap stack via Redis counters (per-user, per-conv, per-tenant, global), Four-Stage Orchestrator Pipeline (Extractor->Merge->Planner->Responder), Idempotency via DB row + agent_tasks.idempotency_key UNIQUE (+24 more)

### Community 9 - "Integration Test Harness"
Cohesion: 0.09
Nodes (31): signOutAction, chatAction, Four-stage orchestrator pipeline (Extract/Merge/Plan/Respond), 5-Step Brand Creation Wizard, Artifact Streaming via SSE, Auth (WorkOS AuthKit), Canonical Agents Directory Pattern, Target Layered Architecture (src/core) (+23 more)

### Community 10 - "Test Fixtures & Builders"
Cohesion: 0.14
Nodes (17): UUID, AgentTaskRowDb, assertJsonbTenantSafe(), extractUuids(), log, DeliverableRowDb, log, AgentTaskIterationInsert (+9 more)

### Community 11 - "Provider Singletons (Image/LLM)"
Cohesion: 0.16
Nodes (21): FalImageProvider, fal-provider.test, generator.test, ImageGeneratorService, image module singleton, image service types, llmCallsRepo, llm provider singleton (+13 more)

### Community 12 - "Planner Decision Variants"
Cohesion: 0.12
Nodes (13): AnnounceDispatchDecision, PlannerDecision, AgentTasksRepoLike, IDecisionNotifier, log, OrchestratorCoreDeps, owner, PendingCompletion (+5 more)

### Community 13 - "Chat Input Adapter (Extractor)"
Cohesion: 0.13
Nodes (13): RequestFieldEntry, fixtureEchoHandler(), AgentCard, AgentRegistryEntry, RequirementField, collectPendingConfirmations(), FieldRef, log (+5 more)

### Community 14 - "Conversation & Field Contracts"
Cohesion: 0.15
Nodes (12): AgentId, AgentRequirementState, ConversationSnapshot, FieldName, FieldSlot, AgentNotRegisteredError, CrossTenantAccessError, InvalidDeltaError (+4 more)

### Community 15 - "RLS & Persistence Rationale"
Cohesion: 0.11
Nodes (12): AdapterSource, AnnounceAllCompleteDecision, AnnounceCompletionDecision, ConfirmFieldDecision, FieldValues, ISOTimestamp, OutputAdapter, RefinementSpec (+4 more)

### Community 16 - "Chat Output Adapter (Responder)"
Cohesion: 0.13
Nodes (15): buildExtractedFieldsSchema(), buildExtractorSystemPrompt(), buildFieldOwnership(), ChatInputAdapter, ExtractInput, FieldOwnership, FieldValueZ, log (+7 more)

### Community 17 - "LLM Provider Test Hooks"
Cohesion: 0.22
Nodes (10): PostgresConversationStore, agentTasksRepo(), conversationsRepo(), deliverablesRepo(), Repos, SystemRepos, llmCallsRepo(), messagesRepo() (+2 more)

### Community 18 - "Orchestrator Core Pipeline"
Cohesion: 0.2
Nodes (14): getPool(), log, Tenant, TxClient, User, withTenantAdminTransaction(), withTenantTransaction(), AgentStatesJson (+6 more)

### Community 19 - "CreaMype Wizard Component"
Cohesion: 0.13
Nodes (10): closePool(), fakeTenantId, insertedIds, r, sys, conversationId, conversationIds, foreign (+2 more)

### Community 20 - "App Layout & Error Boundary"
Cohesion: 0.17
Nodes (17): Persistence (Postgres + RLS), agent_tasks table (DB-as-queue), app_user role (no BYPASSRLS), Single-statement claim with FOR UPDATE SKIP LOCKED CTE, Composite FK (tenant_id, parent_id) cross-tenant guard, conversations table, deliverables table, JSONB tenant-uuid validation at write boundary (+9 more)

### Community 21 - "Domain Error Types"
Cohesion: 0.21
Nodes (8): A2AMessage, A2ATaskResult, AgentHandler, IAgentTransport, TaskState, TaskId, log, RedisQueueAdapterDeps

### Community 22 - "Orchestrator Core Dependencies"
Cohesion: 0.2
Nodes (11): claimById, ctx, failingHandler, fakeHandler, findById, handlerCall, onTaskSettled, registry (+3 more)

### Community 23 - "OpenRouter LLM Provider"
Cohesion: 0.22
Nodes (12): channelForAgent(), DispatchNotification, DeliverablesRepoLike, WorkerContext, DeliverablesRepoLike, log, LOGO_AGENT_ID, LOGO_DELIVERABLE_KIND (+4 more)

### Community 24 - "Planner Internals"
Cohesion: 0.13
Nodes (8): adapter, FakePublisher, fallback, fallbackDispatch, message, payload, publisher, RedisQueueAdapter

### Community 25 - "RLS Migration Strategy"
Cohesion: 0.17
Nodes (9): asRedisClient(), buildAgentTaskRow(), buildWorkerTestContext(), DEFAULT_CONVERSATION_ID, DEFAULT_IDEMPOTENCY_KEY, DEFAULT_TASK_ID, FakeSubscriber, flushMicrotasks() (+1 more)

### Community 26 - "In-Memory Conversation Store"
Cohesion: 0.26
Nodes (7): adapter, ctx, params, priorDecision, provider, recordSpy, registry

### Community 27 - "Agent Registry Entries"
Cohesion: 0.24
Nodes (9): Home(), log, log, ResolvedIdentity, resolveIdentity(), Logger, loggerFor(), root (+1 more)

### Community 28 - "Agent Registry Methods"
Cohesion: 0.17
Nodes (9): __test, conversationIds, foreignUuid, found, newConversation(), sys, u1, u2 (+1 more)

### Community 29 - "Wizard SSE Integration"
Cohesion: 0.22
Nodes (4): metadata, ErrorBoundary, Props, State

### Community 30 - "Testing Conventions"
Cohesion: 0.2
Nodes (4): CapturedCall, FakeLLMProvider, FakeLLMProviderOptions, ScriptedResponse

### Community 31 - "Smoke Scripts & Identity Resolution"
Cohesion: 0.36
Nodes (8): Mandatory cross-tenant isolation behavioral test, RLS scheduled before second tenant, not in Phase 1, SET LOCAL app.tenant_id GUC per transaction, Testcontainers-backed Postgres for tests (no DB mocks), Type-level tenant scoping via repos(tenant) factory, Migration: app_user role + grants (no BYPASSRLS), Migration: app schema + GUC helper functions (current_tenant_id, etc.), Migration: RLS policies (ENABLE/FORCE per tenant table)

### Community 33 - "Migration: Extensions"
Cohesion: 0.29
Nodes (5): log, MessageRowDb, ListMessagesOptions, MessageGenerationStatus, MessageInsert

### Community 35 - "Migration: Messages Table"
Cohesion: 0.33
Nodes (4): CONFIDENCE_THRESHOLDS, FieldDelta, FieldOutcome, log

### Community 36 - "Migration: LLM Calls Table"
Cohesion: 0.33
Nodes (4): arg, client, ctx, recordSpy

### Community 37 - "Migration: Agent States Column"
Cohesion: 0.5
Nodes (5): BrandAssets state type, handleRestart (resets assets/conv/processingAgents), processingAgents set driven by task_processing/artifact SSE events, SSE EventSource subscription to /api/agents/stream, Step derived from filled BrandAssets

### Community 38 - "Migration: Conversations Table"
Cohesion: 0.5
Nodes (4): Adapter tests (input/output) verify FieldDelta/PlannerDecision rendering, Agent handler tests use FakeLLMProvider; assert envelope shape, Use builders (buildSnapshot, buildDelta, buildA2AMessage) over inline literals, Three shared fakes: FakeLLMProvider, FakeInputAdapter, FakeOutputAdapter

### Community 39 - "Migration: Agent Tasks Table"
Cohesion: 0.5
Nodes (4): scripts/db-smoke.mjs, scripts/repo-smoke.mjs, resolveIdentity, Pilot scope: single tenant via PILOT_TENANT_ID

### Community 57 - "cn() Utility"
Cohesion: 0.67
Nodes (3): DISABLE_HMR env var, Next.js standalone config, Webpack file-watching disabled when DISABLE_HMR=true

### Community 58 - "Skill Documents"
Cohesion: 0.67
Nodes (3): Error classifier: transient | content_policy | permanent_bug, Golden-set extractor evaluation (metrics, not pass/fail gate), ILLMProvider abstraction (Gemini Flash/Pro)

## Ambiguous Edges - Review These
- `CreaMype client component (monolithic UI)` → `useIsMobile hook (matchMedia 768px breakpoint)`  [AMBIGUOUS]
  hooks/use-mobile.ts · relation: conceptually_related_to
- `image service types` → `LocalAdapter`  [AMBIGUOUS]
  src/transport/local-adapter.ts · relation: references

## Knowledge Gaps
- **290 isolated node(s):** `config`, `config`, `__filename`, `__dirname`, `nextConfig` (+285 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **30 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `CreaMype client component (monolithic UI)` and `useIsMobile hook (matchMedia 768px breakpoint)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `image service types` and `LocalAdapter`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `loggerFor()` connect `Agent Registry Entries` to `Chat Action & Server Entry`, `Migration: Extensions`, `Agent Registry & A2A Cards`, `IDs, FieldDeltas & Decision Notifier`, `Migration: Messages Table`, `Orchestrator Design Rationale`, `Test Fixtures & Builders`, `Planner Decision Variants`, `Chat Input Adapter (Extractor)`, `Chat Output Adapter (Responder)`, `LLM Provider Test Hooks`, `Orchestrator Core Pipeline`, `Domain Error Types`, `OpenRouter LLM Provider`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `startLogoAgentWorker()` connect `OpenRouter LLM Provider` to `Chat Action & Server Entry`, `Orchestrator Core Dependencies`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `UUID` connect `Test Fixtures & Builders` to `Chat Action & Server Entry`, `Migration: Extensions`, `Agent Handlers & A2A Transport`, `Planner Decision Variants`, `Conversation & Field Contracts`, `RLS & Persistence Rationale`, `Orchestrator Core Pipeline`, `CreaMype Wizard Component`, `Domain Error Types`, `Orchestrator Core Dependencies`, `OpenRouter LLM Provider`, `Planner Internals`, `Agent Registry Methods`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **What connects `config`, `config`, `__filename` to the rest of the system?**
  _290 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Chat Action & Server Entry` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._