/**
 * D38 / D39 THE limit gate: the single chokepoint every paid path calls before doing work
 * (iterations/refinements, chat turns) and the single source of the remaining counts the UI and the
 * planner read. Count limits (brands, products) are decided inside their creation transactions with the
 * same rules (`checkLimit`). I/O comes through an injected port; the decision is `rules.ts`.
 *
 * Returns typed refusals and never throws for a refusal; infrastructure errors propagate to the caller,
 * which already maps them to its generic failure (fail closed: no paid work happens).
 */
import type { UUID } from '../contracts';
import { loggerFor } from '../../services/logger';
import { TURNS_KEY, alterationKey, withDefaults, type LimitCatalog, type LimitScope, type LimitValues } from './catalog';
import { checkLimit, remaining, type LimitRefusal } from './rules';

const log = loggerFor('limits.gate');

/** What the gate needs from storage (implemented by `repos(...).limits`). */
export interface LimitsPort {
  effectiveLimits(): Promise<LimitValues>;
  alterationUsage(input: { conversationId: UUID; agentId: string; scope: LimitScope }): Promise<{ used: number; hasResult: boolean }>;
  turnsUsed(conversationId: UUID): Promise<number>;
}

export interface RemainingCount {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}

export interface RemainingCounts {
  readonly turns: RemainingCount;
  /** By agent id (one deliverable kind per agent). */
  readonly alterations: Readonly<Record<string, RemainingCount>>;
}

export interface LimitGate {
  /** An iteration/refinement (Iterar, Reintentar) of `agentId`'s deliverable in the conversation. */
  checkAlteration(conversationId: UUID, agentId: string): Promise<LimitRefusal | null>;
  /** A chat message that is about to trigger the model. */
  checkTurn(conversationId: UUID): Promise<LimitRefusal | null>;
  remaining(conversationId: UUID): Promise<RemainingCounts>;
}

const count = (limit: number, used: number): RemainingCount => ({ limit, used, remaining: remaining(limit, used) });

export function createLimitGate(port: LimitsPort, catalog: LimitCatalog): LimitGate {
  const limitsNow = async () => withDefaults(catalog, await port.effectiveLimits());
  const alterationDefs = catalog.filter((def) => def.group === 'alterations' && def.agentId);

  return {
    async checkAlteration(conversationId, agentId) {
      const def = alterationDefs.find((d) => d.agentId === agentId);
      if (!def) return null; // not a limited deliverable; the command layer rejects unknown agents itself
      const [limits, usage] = await Promise.all([limitsNow(), port.alterationUsage({ conversationId, agentId, scope: def.scope })]);
      const refusal = checkLimit(
        limits,
        { kind: 'alteration', agentId, deliverableLabel: def.deliverableLabel ?? agentId, firstGeneration: !usage.hasResult },
        usage.used,
      );
      log.debug({ conversationId, agentId, used: usage.used, hasResult: usage.hasResult, refused: refusal?.kind }, 'gate.alteration');
      if (refusal) log.info({ conversationId, agentId, limit: refusal.limit, used: refusal.used }, 'gate.refused');
      return refusal;
    },

    async checkTurn(conversationId) {
      const [limits, used] = await Promise.all([limitsNow(), port.turnsUsed(conversationId)]);
      const refusal = checkLimit(limits, { kind: 'turn' }, used);
      log.debug({ conversationId, used, refused: refusal?.kind }, 'gate.turn');
      if (refusal) log.info({ conversationId, limit: refusal.limit, used: refusal.used }, 'gate.refused');
      return refusal;
    },

    async remaining(conversationId) {
      const [limits, turnsUsed, perAgent] = await Promise.all([
        limitsNow(),
        port.turnsUsed(conversationId),
        Promise.all(alterationDefs.map(async (def) => [
          def.agentId as string,
          await port.alterationUsage({ conversationId, agentId: def.agentId as string, scope: def.scope }),
        ] as const)),
      ]);
      return {
        turns: count(limits[TURNS_KEY] ?? 0, turnsUsed),
        alterations: Object.fromEntries(perAgent.map(([agentId, usage]) => [agentId, count(limits[alterationKey(agentId)] ?? 0, usage.used)])),
      };
    },
  };
}
