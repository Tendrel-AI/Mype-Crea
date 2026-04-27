/**
 * MYPES Platform — Agent registry
 * ================================
 *
 * Location: src/orchestrator/agent-registry.ts
 *
 * At boot the registry:
 *   1. Reads every Agent Card in /agents/
 *   2. Resolves its handler module (for local-protocol agents)
 *   3. Builds the field schemas the Planner needs
 *
 * The registry is the ONLY place in the orchestrator that knows about the
 * concrete set of agents. Everywhere else, agents are opaque handles
 * identified by AgentId.
 *
 * In Phase 1 (this file), handlers are resolved to in-process modules.
 * In Phase 2, the registry's resolveHandler() would return either a local
 * function OR a "remote dispatcher" object depending on the card's
 * supportedInterfaces.protocol field.
 *
 * See also:
 *   - agent-types.ts  (AgentHandler contract)
 *   - in-memory-store.ts  (AgentFieldSchema, seeded by us at boot)
 */

import type { AgentHandler } from '../agent-types';
import type { AgentId } from '../contracts';
import type { AgentFieldSchema } from './in-memory-store';

// ---------------------------------------------------------------------------
// Agent Card shape (what the registry reads from disk)
// ---------------------------------------------------------------------------

export interface AgentCard {
  readonly name: AgentId;
  readonly description: string;
  readonly version: string;
  readonly skills: ReadonlyArray<unknown>;
  readonly 'mypes:requirements': {
    readonly required: ReadonlyArray<RequirementField>;
    readonly optional: ReadonlyArray<RequirementField>;
  };
  readonly 'mypes:ui': {
    readonly tabLabel: string;
    readonly tabIcon: string;
    readonly displayOrder: number;
    readonly outputPreview: string;
  };
  readonly supportedInterfaces: ReadonlyArray<
    | { readonly protocol: 'local'; readonly module: string }
    | { readonly protocol: 'bullmq'; readonly queue: string }
    | { readonly protocol: 'jsonrpc'; readonly url: string }
  >;
}

export interface RequirementField {
  readonly name: string;
  readonly type: string;
  readonly promptHint: string;
  readonly enumValues?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

export interface AgentRegistryEntry {
  readonly card: AgentCard;
  readonly handler: AgentHandler<unknown>;
  readonly handlerDeps: unknown;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private readonly entries = new Map<AgentId, AgentRegistryEntry>();

  /**
   * Register an agent explicitly. In production, a bootstrapper iterates
   * /agents/* and calls this for each card. In tests, the test wires up
   * only the agents it needs.
   */
  register<Deps>(card: AgentCard, handler: AgentHandler<Deps>, deps: Deps): void {
    if (this.entries.has(card.name)) {
      throw new Error(`Agent already registered: ${card.name}`);
    }
    this.entries.set(card.name, {
      card,
      handler: handler as AgentHandler<unknown>,
      handlerDeps: deps,
    });
  }

  get(agentId: AgentId): AgentRegistryEntry {
    const entry = this.entries.get(agentId);
    if (!entry) throw new Error(`Agent not registered: ${agentId}`);
    return entry;
  }

  list(): ReadonlyArray<AgentRegistryEntry> {
    return [...this.entries.values()];
  }

  /**
   * Field schemas extracted from Agent Cards, used by the store to seed
   * field slots when a conversation is created, and by the Planner to
   * know which fields to ask about in what order.
   */
  getFieldSchemas(): ReadonlyArray<AgentFieldSchema> {
    return this.list().map((entry) => ({
      agentId: entry.card.name,
      requiredFields: entry.card['mypes:requirements'].required.map((f) => f.name),
      optionalFields: entry.card['mypes:requirements'].optional.map((f) => f.name),
      displayOrder: entry.card['mypes:ui'].displayOrder,
    }));
  }

  /**
   * Find the prompt hint for a given (agentId, fieldName) — used by the
   * Planner when emitting request_field decisions.
   */
  getPromptHint(agentId: AgentId, fieldName: string): string {
    const entry = this.get(agentId);
    const reqs = entry.card['mypes:requirements'];
    const match =
      reqs.required.find((f) => f.name === fieldName) ??
      reqs.optional.find((f) => f.name === fieldName);
    if (!match) throw new Error(`Unknown field ${fieldName} for agent ${agentId}`);
    return match.promptHint;
  }
}