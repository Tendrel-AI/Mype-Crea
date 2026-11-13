/**
 * D42 / F22: the single node that produces forecasts. `computeAndStore` reads history + balance, runs the
 * pure engine and stores the dated snapshot; the tenant repo and the platform repo both call it.
 * The current-month snapshot is computed once (first read or the monthly script) and then served as stored.
 */
import { ENGINE_VERSION, forecast, type ForecastResult, type MonthHistory } from '../core/forecast/engine';
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { NotTenantAdminError } from './tenant-accounts';

const log = loggerFor('repos.forecast');

export interface ForecastSnapshot {
  /** `YYYY-MM-01`. */
  readonly month: string;
  readonly forecast: ForecastResult;
  readonly inputs: { readonly history: ReadonlyArray<MonthHistory>; readonly balanceUsd: number };
  readonly engineVersion: string;
}

export interface ForecastView {
  readonly current: ForecastSnapshot;
  /** Up to the last 6 stored snapshots, newest first (includes `current`). */
  readonly recent: ReadonlyArray<ForecastSnapshot>;
}

interface SnapshotRow { month: string; inputs: ForecastSnapshot['inputs']; forecast: ForecastResult; engine_version: string }
const toSnapshot = (r: SnapshotRow): ForecastSnapshot => ({ month: r.month, inputs: r.inputs, forecast: r.forecast, engineVersion: r.engine_version });

const SNAPSHOT_COLUMNS = `to_char(month, 'YYYY-MM-DD') AS month, inputs, forecast, engine_version`;

/** Caller's tx must carry tenant-admin (tenant tx) or platform (global tx) authority; the SQL functions re-check it. */
export async function computeAndStore(tx: TxClient, tenantId: string): Promise<ForecastView> {
  const current = await tx.query<{ month: string }>(
    `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'America/Lima'), 'YYYY-MM-DD') AS month`);
  const month = current.rows[0].month;
  const existing = await tx.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM tenant_forecast_snapshots WHERE tenant_id = $1 AND month = $2`, [tenantId, month]);
  if (existing.rows.length === 0) {
    const [hist, bal] = await Promise.all([
      tx.query<{ history: MonthHistory[] }>('SELECT app.forecast_history($1, $2::date) AS history', [tenantId, month]),
      tx.query<{ balance: string }>('SELECT coalesce(sum(amount_usd), 0)::text AS balance FROM tenant_credit_entries WHERE tenant_id = $1', [tenantId]),
    ]);
    const inputs = { history: hist.rows[0].history, balanceUsd: Number(bal.rows[0].balance) };
    const result = forecast(inputs);
    await tx.query('SELECT app.store_forecast_snapshot($1, $2::date, $3::jsonb, $4::jsonb, $5)',
      [tenantId, month, JSON.stringify(inputs), JSON.stringify(result), ENGINE_VERSION]);
    log.info({ tenantId, month, weight: result.weight, pocosDatos: result.pocosDatos }, 'forecast.snapshot_stored');
  } else {
    log.debug({ tenantId, month }, 'forecast.snapshot_hit');
  }
  const recent = await tx.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM tenant_forecast_snapshots WHERE tenant_id = $1 ORDER BY month DESC LIMIT 6`, [tenantId]);
  const snapshots = recent.rows.map(toSnapshot);
  return { current: snapshots.find((s) => s.month === month) ?? snapshots[0], recent: snapshots };
}

export function forecastRepo(tenant: Tenant, user: User) {
  return {
    /** Tenant admin only: the current-month snapshot, computed and stored if missing. */
    async latest(): Promise<ForecastView> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const admin = await tx.query<{ ok: boolean }>('SELECT app.has_tenant_admin() AS ok');
        if (!admin.rows[0]?.ok) throw new NotTenantAdminError();
        return computeAndStore(tx, tenant.id);
      });
    },
  };
}

export type ForecastRepo = ReturnType<typeof forecastRepo>;
