/**
 * Wiring of the limit gate: the catalog derived from the live registry and the repository port.
 * Same role as `src/core/orchestrator/runtime.ts` for the orchestrator.
 */
import { repos, type Tenant, type User } from '../../repos';
import { buildDefaultRegistry } from '../orchestrator/bootstrap-registry';
import { buildLimitCatalog, type LimitCatalog } from './catalog';
import { createLimitGate, type LimitGate } from './gate';

let catalog: LimitCatalog | undefined;

/** The catalog of every limit key, derived from the registered Agent Cards (built once per process). */
export function getLimitCatalog(): LimitCatalog {
  catalog ??= buildLimitCatalog(buildDefaultRegistry().list().map((entry) => entry.card));
  return catalog;
}

export function getLimitGate(tenant: Tenant, user: User): LimitGate {
  return createLimitGate(repos(tenant, user).limits, getLimitCatalog());
}
