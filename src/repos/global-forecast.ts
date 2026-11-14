/** D42 platform side: same snapshot as the tenant sees, via the shared `computeAndStore`, in a global transaction. */
import { withGlobalTransaction } from '../db/global-transaction';
import { computeAndStore, type ForecastView } from './forecast';

export function globalForecastRepo() {
  return {
    forTenant: (tenantId: string): Promise<ForecastView> => withGlobalTransaction((tx) => computeAndStore(tx, tenantId)),
  };
}

export type GlobalForecastRepo = ReturnType<typeof globalForecastRepo>;
