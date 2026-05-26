/**
 * MYPES Platform — Core Contracts (back-compat barrel)
 * =====================================================
 *
 * Single source of truth for the interfaces and data shapes that cross the
 * orchestrator's module boundaries. The contracts are split into focused
 * slices under `./contracts/`; this file re-exports them so existing
 * `from '../core/contracts'` imports keep working.
 *
 * Slices:
 *   - contracts/ids.ts          — primitive aliases (UUID, ConversationId, etc.)
 *   - contracts/conversation.ts — ConversationSnapshot, FieldSlot, requirement state
 *   - contracts/decisions.ts    — PlannerDecision union + variants + type guards
 *   - contracts/deltas.ts       — FieldDelta, intent, adapter interfaces, confidence
 *   - contracts/core.ts         — OrchestratorCore interface
 *
 * RULES FOR MODIFYING CONTRACTS (unchanged from the original location)
 * --------------------------------------------------------------------
 *   1. Anything added here becomes part of the public contract between the
 *      orchestrator core, input adapters, output adapters, and sub-agents.
 *      Treat additions as API changes.
 *   2. The orchestrator core MUST NOT depend on any concept not declared here
 *      (no direct references to chat, forms, Gemini, HTTP, etc.).
 *   3. Input and output adapters MUST NOT add fields to FieldDelta or
 *      PlannerDecision to encode modality-specific state. Modality state
 *      lives inside the adapter.
 *   4. New PlannerDecision variants require a design discussion — the
 *      decision set is intentionally bounded.
 *   5. The `source` field on FieldDelta is for audit and debugging only.
 *      The core MUST NOT branch on it.
 *
 * See also:
 *   - .claude/skills/mypes-architecture/SKILL.md  (architectural constitution)
 *   - docs/adr/                                    (architectural decisions)
 */

export * from './contracts/index';
