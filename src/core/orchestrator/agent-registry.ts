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
import { isDeprecatedField } from '../brief';
import type { AgentFieldSchema } from './in-memory-store';

/** D41: a deprecated catalog field is never asked, whatever the cards still declare. */
const asked = (fields: ReadonlyArray<RequirementField>) => fields.filter((f) => !isDeprecatedField(f.name)).map((f) => f.name);

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
    /** How many missing required fields the planner may ask in one turn; absent = `MAX_FIELD_BATCH_SIZE`. */
    readonly askBatchSize?: number;
    /** D34: files the user must upload before this agent can work (e.g. `lab_report`); asked after the fields. */
    readonly uploads?: ReadonlyArray<UploadRequirement>;
  };
  readonly 'mypes:ui': {
    readonly tabLabel: string;
    readonly tabIcon: string;
    readonly displayOrder: number;
    readonly outputPreview: string;
  };
  /**
   * Declarative deliverable spec (KAN-28/KAN-64). `kind` is the
   * `deliverable_kind` this agent produces; `dependsOn` lists the upstream
   * deliverable kinds that must be approved (and not stale) before this one
   * can be generated. Unlocking follows this data, never an `if` in the core.
   * Optional: when absent, kind = agent id and there are no dependencies.
   */
  readonly 'mypes:deliverable'?: {
    readonly kind: string;
    readonly dependsOn: ReadonlyArray<string>;
    /**
     * KAN-89: `brand` kinds are approved once per brand and reused by every conversation of it (default
     * `product`). `ownSource` says what «Usar mi …» takes for this kind: typed `text`, or the brand's
     * uploaded logo. Absent: the user cannot bring their own version.
     */
    readonly level?: 'brand' | 'product';
    readonly ownSource?: 'text' | 'brand_logo';
    /** D32: `false` = the chat never offers «Generar» for it (it starts from another user action, e.g. an upload). Default true. */
    readonly offerable?: boolean;
  };
  readonly supportedInterfaces: ReadonlyArray<
    | { readonly protocol: 'local'; readonly module: string }
    | { readonly protocol: 'bullmq'; readonly queue: string }
    | { readonly protocol: 'jsonrpc'; readonly url: string }
  >;
}

/** D34: a required upload kind (`brand_files.kind`), with the minimum count and the hint shown to the user. */
export interface UploadRequirement {
  readonly kind: string;
  readonly min: number;
  readonly promptHint: string;
}

export interface RequirementField {
  readonly name: string;
  readonly type: string;
  readonly promptHint: string;
  readonly enumValues?: ReadonlyArray<string>;
  /** D41: `type: 'enum'` fields name a dictionary (`src/core/dictionaries`); must equal the catalog's `vocabulary`. */
  readonly vocabulary?: string;
  /** D35: a required field the user may leave to the agent; never blocks generation, sent as `DELEGATED_FIELD_VALUE` when empty. */
  readonly delegable?: boolean;
}

/** What the pure deliverable state function needs to know about one agent. */
export interface DeliverableSpec {
  readonly agentId: AgentId;
  readonly deliverableKind: string;
  readonly requiredFields: ReadonlyArray<string>;
  /** D35: subset of `requiredFields` that may stay empty; absent = none. */
  readonly delegableFields?: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
  /** Absent means `product` (KAN-89). */
  readonly level?: 'brand' | 'product';
  readonly ownSource?: 'text' | 'brand_logo';
  /** Absent means true. */
  readonly offerable?: false;
  /** D34: required uploads; absent means none. */
  readonly uploads?: ReadonlyArray<UploadRequirement>;
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
      requiredFields: asked(entry.card['mypes:requirements'].required),
      optionalFields: asked(entry.card['mypes:requirements'].optional),
      displayOrder: entry.card['mypes:ui'].displayOrder,
      ...delegableOf(entry.card),
      ...(entry.card['mypes:requirements'].askBatchSize
        ? { askBatchSize: entry.card['mypes:requirements'].askBatchSize }
        : {}),
    }));
  }

  /**
   * Declarative dependency map: one spec per registered agent, sorted by
   * agentId. Read from each card's `mypes:deliverable` extension.
   */
  getDeliverableSpecs(): ReadonlyArray<DeliverableSpec> {
    return this.list()
      .map((entry) => {
        const declared = entry.card['mypes:deliverable'];
        return {
          agentId: entry.card.name,
          deliverableKind: declared?.kind ?? entry.card.name,
          requiredFields: asked(entry.card['mypes:requirements'].required),
          ...delegableOf(entry.card),
          dependsOn: [...(declared?.dependsOn ?? [])].sort(),
          level: declared?.level ?? 'product',
          ...(declared?.ownSource ? { ownSource: declared.ownSource } : {}),
          ...(declared?.offerable === false ? { offerable: false as const } : {}),
          ...(entry.card['mypes:requirements'].uploads?.length ? { uploads: entry.card['mypes:requirements'].uploads } : {}),
        };
      })
      .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
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

/** D35: the card's delegable required fields, or nothing. */
function delegableOf(card: AgentCard): { readonly delegableFields?: ReadonlyArray<string> } {
  const names = card['mypes:requirements'].required.filter((f) => f.delegable === true && !isDeprecatedField(f.name)).map((f) => f.name);
  return names.length > 0 ? { delegableFields: names } : {};
}
