/**
 * Tenant sub-key lifecycle (D36): create on first recharge, mirror the balance in the key limit
 * (on every recharge/adjustment and, throttled, after settlements), disable on suspension, hand the
 * decrypted key to the provider registry, and build the OpenRouter reconciliation view.
 * Pure orchestration over injected ports; the sub-key plaintext is never logged.
 */
import type { GlobalCreditsRepo, MonthlyLedgerConsumption } from '../../repos/global-credits';
import { globalCreditsRepo } from '../../repos/global-credits';
import { loggerFor } from '../logger';
import { createProviderKeyCipher, type ProviderKeyCipher } from '../secrets/provider-key-cipher';
import {
  HttpOpenRouterProvisioning,
  keyLimitFor,
  type KeyUsage,
  type OpenRouterProvisioning,
} from './provisioning';

const log = loggerFor('service.openrouter.tenant-keys');

export type TenantKeyStore = Pick<GlobalCreditsRepo, 'balance' | 'findKey' | 'insertKey' | 'updateKey' | 'openRouterConsumptionByMonth'>;

export interface ReconciliationRow {
  readonly month: string;
  readonly ledgerUsd: number;
  /** OpenRouter reports monthly usage only for the current UTC month; null for older months. */
  readonly keyUsageUsd: number | null;
  readonly differenceUsd: number | null;
}

export interface Reconciliation {
  readonly hasKey: boolean;
  readonly months: readonly ReconciliationRow[];
  readonly totalLedgerUsd: number;
  readonly totalKeyUsageUsd: number | null;
  readonly totalDifferenceUsd: number | null;
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export class TenantKeyService {
  private readonly usageCache = new Map<string, { at: number; usage: KeyUsage }>();
  private readonly lastSync = new Map<string, number>();

  constructor(
    private readonly store: TenantKeyStore,
    private readonly provisioning: OpenRouterProvisioning,
    private readonly cipher: () => ProviderKeyCipher,
    private readonly now: () => number = Date.now,
    private readonly cacheTtlMs = 5 * 60_000,
    private readonly syncIntervalMs = 5 * 60_000,
  ) {}

  /** Creates the tenant's sub-key once (limit = balance at cost basis). Returns true when created. */
  async ensureKey(tenantId: string, actorWorkosUserId: string): Promise<boolean> {
    if (await this.store.findKey(tenantId)) return false;
    const balance = await this.store.balance(tenantId);
    const { hash, key } = await this.provisioning.createKey({ name: tenantId, limitUsd: keyLimitFor(balance, 0) });
    const created = await this.store.insertKey(actorWorkosUserId, {
      tenantId, keyCiphertext: this.cipher().encrypt(key, tenantId), keyHash: hash,
      limitUsd: keyLimitFor(balance, 0), status: 'active',
    });
    // A concurrent creator won the row: ours is an orphan, disable it so it can never spend.
    if (!created) await this.provisioning.updateKey(hash, { disabled: true });
    log.debug({ tenantId, created }, 'tenant_key.ensure');
    return created;
  }

  /** Sets the key limit so its remaining credit equals the ledger balance. No-op without an active key. */
  async syncLimit(tenantId: string): Promise<void> {
    const stored = await this.store.findKey(tenantId);
    if (!stored || stored.status !== 'active') return;
    const usage = await this.provisioning.getKeyUsage(this.cipher().decrypt(stored.keyCiphertext, tenantId));
    const limitUsd = keyLimitFor(await this.store.balance(tenantId), usage.usageUsd);
    await this.provisioning.updateKey(stored.keyHash, { limitUsd });
    await this.store.updateKey(tenantId, { limitUsd });
    this.lastSync.set(tenantId, this.now());
    log.debug({ tenantId, limitUsd }, 'tenant_key.limit_synced');
  }

  /** Disable on suspension; re-enable (and re-sync the limit) on reactivation. */
  async setEnabled(tenantId: string, enabled: boolean): Promise<void> {
    const stored = await this.store.findKey(tenantId);
    if (!stored) return;
    await this.provisioning.updateKey(stored.keyHash, { disabled: !enabled });
    await this.store.updateKey(tenantId, { status: enabled ? 'active' : 'disabled' });
    if (enabled) await this.syncLimit(tenantId);
    log.debug({ tenantId, enabled }, 'tenant_key.enabled_changed');
  }

  /** Decrypted active sub-key, or undefined when the tenant has none (callers fall back to the platform key). */
  async resolveKey(tenantId: string): Promise<string | undefined> {
    const stored = await this.store.findKey(tenantId);
    return stored?.status === 'active' ? this.cipher().decrypt(stored.keyCiphertext, tenantId) : undefined;
  }

  /** Fire-and-forget limit sync after a settlement, at most once per interval per tenant. */
  scheduleSync(tenantId: string): void {
    const last = this.lastSync.get(tenantId);
    if (last !== undefined && this.now() - last < this.syncIntervalMs) return;
    this.lastSync.set(tenantId, this.now());
    void this.syncLimit(tenantId).catch((err: unknown) => {
      log.error({ tenantId, err: err instanceof Error ? err.name : 'unknown' }, 'tenant_key.sync_failed');
    });
  }

  /** Ledger consumption (OpenRouter calls) vs the key's own usage, per month; key usage cached. */
  async reconcile(actorWorkosUserId: string, tenantId: string): Promise<Reconciliation> {
    const ledger = await this.store.openRouterConsumptionByMonth(actorWorkosUserId, tenantId);
    const stored = await this.store.findKey(tenantId);
    const usage = stored ? await this.cachedUsage(tenantId, stored.keyCiphertext) : undefined;
    const currentMonth = new Date(this.now()).toISOString().slice(0, 7);
    const months = (ledger.some((m) => m.month === currentMonth) ? ledger : [{ month: currentMonth, usd: 0 }, ...ledger])
      .map((m: MonthlyLedgerConsumption) => {
        const keyUsageUsd = usage && m.month === currentMonth ? usage.usageMonthlyUsd : null;
        return { month: m.month, ledgerUsd: m.usd, keyUsageUsd, differenceUsd: keyUsageUsd === null ? null : round6(m.usd - keyUsageUsd) };
      });
    const totalLedgerUsd = round6(ledger.reduce((sum, m) => sum + m.usd, 0));
    return {
      hasKey: Boolean(stored), months, totalLedgerUsd,
      totalKeyUsageUsd: usage ? usage.usageUsd : null,
      totalDifferenceUsd: usage ? round6(totalLedgerUsd - usage.usageUsd) : null,
    };
  }

  private async cachedUsage(tenantId: string, ciphertext: string): Promise<KeyUsage> {
    const hit = this.usageCache.get(tenantId);
    if (hit && this.now() - hit.at < this.cacheTtlMs) return hit.usage;
    const usage = await this.provisioning.getKeyUsage(this.cipher().decrypt(ciphertext, tenantId));
    this.usageCache.set(tenantId, { at: this.now(), usage });
    return usage;
  }
}

let defaultService: TenantKeyService | undefined;

/** Env-wired service; null when `OPENROUTER_PROVISIONING_KEY` is unset (dev/evals use the platform key). */
export function defaultTenantKeyService(): TenantKeyService | null {
  const provisioningKey = process.env.OPENROUTER_PROVISIONING_KEY?.trim();
  if (!provisioningKey) return null;
  defaultService ??= new TenantKeyService(globalCreditsRepo(), new HttpOpenRouterProvisioning(provisioningKey), () => createProviderKeyCipher());
  return defaultService;
}
