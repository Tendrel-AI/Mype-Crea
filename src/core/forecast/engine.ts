/**
 * D42 / F22 forecast engine. Pure: no I/O, no clock. Bump ENGINE_VERSION when the maths change.
 *
 * Every estimate is a shrinkage between the platform seed and the tenant's own mean:
 *   estimate = w * tenantMean + (1 - w) * seed,  w = n / (n + SHRINKAGE_K)
 * with n = settled provider calls. At n = 0 it is the seed; as n grows it converges to the tenant.
 */
import { FORECAST_SEED, type ForecastSeed } from './seed';

export const ENGINE_VERSION = 'forecast-1';
/** Pseudo-observations the seed is worth: at n = SHRINKAGE_K calls the weight is 0.5. */
export const SHRINKAGE_K = 20;
/** Below this many settled calls the forecast is flagged «pocos datos» (low confidence). */
export const MIN_SETTLED_CALLS = 10;
export const HIGH_CONFIDENCE_CALLS = 100;
/** Months of history (most recent first) that define the tenant's rhythm. */
export const RHYTHM_MONTHS = 3;
/** Suggested recharges are rounded up to a multiple of this, USD. */
export const RECHARGE_STEP_USD = 5;

export interface MonthHistory {
  /** `YYYY-MM-01`. */
  readonly month: string;
  readonly brands: number;
  readonly products: number;
  readonly deliverables: Readonly<Record<string, number>>;
  readonly alterations: number;
  readonly turns: number;
  readonly costUsd: { readonly llm: number; readonly image: number };
  readonly settledCalls: number;
  readonly rechargedUsd: number;
}

export interface ForecastInput {
  /** Complete months only, newest first. */
  readonly history: ReadonlyArray<MonthHistory>;
  readonly balanceUsd: number;
}

export type Confidence = 'low' | 'medium' | 'high';

export interface ForecastResult {
  readonly expectedSpendUsd: number;
  readonly perNewBrandUsd: number;
  readonly perNewProductUsd: number;
  readonly suggestedRechargeUsd: number;
  readonly confidence: Confidence;
  readonly pocosDatos: boolean;
  /** Shrinkage weight given to the tenant's own history (0..1). */
  readonly weight: number;
  readonly settledCalls: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const sum = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: ReadonlyArray<number>) => (xs.length === 0 ? 0 : sum(xs) / xs.length);
const shrink = (seed: number, tenant: number, w: number) => w * tenant + (1 - w) * seed;
const monthCost = (m: MonthHistory) => m.costUsd.llm + m.costUsd.image;

/** Bottom-up spend of one month of activity at the seed unit costs. */
function seedSpend(
  a: { deliverables: Readonly<Record<string, number>>; alterations: number; turns: number },
  seed: ForecastSeed,
): number {
  const generated = Object.entries(a.deliverables).reduce(
    (acc, [kind, n]) => acc + n * (seed.costPerDeliverableUsd[kind] ?? seed.costPerDeliverableDefaultUsd), 0);
  return generated + a.alterations * seed.costPerAlterationUsd + a.turns * seed.costPerTurnUsd;
}

export function forecast(input: ForecastInput, seed: ForecastSeed = FORECAST_SEED): ForecastResult {
  const recent = input.history.slice(0, RHYTHM_MONTHS);
  const settledCalls = sum(input.history.map((m) => m.settledCalls));
  const w = settledCalls / (settledCalls + SHRINKAGE_K);

  // Expected activity next month: the tenant's recent mean, or the seed's default month with no history.
  const kinds = new Set(recent.flatMap((m) => Object.keys(m.deliverables)));
  const activity = recent.length === 0
    ? seed.defaultMonth
    : {
        deliverables: Object.fromEntries([...kinds].map((k) => [k, mean(recent.map((m) => m.deliverables[k] ?? 0))])),
        alterations: mean(recent.map((m) => m.alterations)),
        turns: mean(recent.map((m) => m.turns)),
      };
  const expectedSpendUsd = shrink(seedSpend(activity, seed), mean(recent.map(monthCost)), recent.length === 0 ? 0 : w);

  // The tenant's all-in cost per brand/product: total cost split in the seed's brand:product proportion.
  const ratio = seed.costPerProductUsd / seed.costPerBrandUsd;
  const units = sum(input.history.map((m) => m.brands + m.products * ratio));
  const tenantBrand = units > 0 ? sum(input.history.map(monthCost)) / units : seed.costPerBrandUsd;
  const wUnit = units > 0 ? w : 0;
  const perNewBrandUsd = shrink(seed.costPerBrandUsd, tenantBrand, wUnit);
  const perNewProductUsd = shrink(seed.costPerProductUsd, tenantBrand * ratio, wUnit);

  const shortfall = Math.max(0, expectedSpendUsd - input.balanceUsd);
  const suggestedRechargeUsd = Math.ceil(shortfall / RECHARGE_STEP_USD - 1e-9) * RECHARGE_STEP_USD || 0; // `|| 0` drops -0
  const pocosDatos = settledCalls < MIN_SETTLED_CALLS;
  return {
    expectedSpendUsd: round6(expectedSpendUsd),
    perNewBrandUsd: round6(perNewBrandUsd),
    perNewProductUsd: round6(perNewProductUsd),
    suggestedRechargeUsd,
    confidence: pocosDatos ? 'low' : settledCalls < HIGH_CONFIDENCE_CALLS ? 'medium' : 'high',
    pocosDatos,
    weight: round6(w),
    settledCalls,
  };
}
