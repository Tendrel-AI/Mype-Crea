/**
 * Platform seed for the forecast engine (D42): average costs in USD, used until a tenant has its own history.
 * shortcut: seed typed by hand on 2026-11-12, replace with cross-tenant averages when there are ≥5 tenants
 */
export interface ForecastSeed {
  readonly costPerBrandUsd: number;
  readonly costPerProductUsd: number;
  /** Unit cost of one generation, by deliverable kind. */
  readonly costPerDeliverableUsd: Readonly<Record<string, number>>;
  readonly costPerDeliverableDefaultUsd: number;
  readonly costPerAlterationUsd: number;
  readonly costPerTurnUsd: number;
  /** Activity assumed for a month when the tenant has no history. */
  readonly defaultMonth: {
    readonly deliverables: Readonly<Record<string, number>>;
    readonly alterations: number;
    readonly turns: number;
  };
}

export const FORECAST_SEED: ForecastSeed = Object.freeze({
  costPerBrandUsd: 0.6,
  costPerProductUsd: 0.4,
  costPerDeliverableUsd: { logo: 0.08, name: 0.01, tagline: 0.01 },
  costPerDeliverableDefaultUsd: 0.03,
  costPerAlterationUsd: 0.06,
  costPerTurnUsd: 0.004,
  defaultMonth: { deliverables: { logo: 4, name: 4, tagline: 4 }, alterations: 6, turns: 60 },
});
