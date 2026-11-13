/**
 * OpenRouter key provisioning (D36): the platform creates one sub-key per tenant, mirrors the
 * tenant's credit balance in its `limit`, and disables it when the tenant is suspended.
 * Behind an interface so tests and local dev use the in-memory fake; the HTTP client takes an
 * injected `fetch`. Env `OPENROUTER_PROVISIONING_KEY` authorizes key management; the sub-key itself
 * authorizes `GET /key`. Neither is ever logged.
 */
import { randomUUID } from 'node:crypto';
import { registerSecret } from '../secrets/redaction';

const BASE_URL = 'https://openrouter.ai/api/v1';

export interface ProvisionedKey { readonly hash: string; readonly key: string }
export interface KeyUsage {
  /** All-time spend of the key, USD. */
  readonly usageUsd: number;
  /** Spend in the current calendar month (UTC), USD. */
  readonly usageMonthlyUsd: number;
  readonly limitUsd: number | null;
  readonly disabled: boolean;
}

export interface OpenRouterProvisioning {
  createKey(input: { name: string; limitUsd: number }): Promise<ProvisionedKey>;
  updateKey(hash: string, patch: { limitUsd?: number; disabled?: boolean }): Promise<void>;
  /** `GET /api/v1/key` authenticated with the sub-key itself. */
  getKeyUsage(subKey: string): Promise<KeyUsage>;
}

/**
 * Limit that makes the key's remaining credit equal the tenant balance: OpenRouter's remaining is
 * `limit - usage`, so the cap is the balance PLUS what the key already spent (cost basis, USD).
 */
export function keyLimitFor(balanceUsd: number, keyUsageUsd: number): number {
  return Math.round((Math.max(0, balanceUsd) + keyUsageUsd) * 1_000_000) / 1_000_000;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class OpenRouterProvisioningError extends Error {
  constructor(readonly operation: string, readonly status: number) {
    super(`OpenRouter provisioning ${operation} failed (HTTP ${status}).`);
    this.name = 'OpenRouterProvisioningError';
  }
}

export class HttpOpenRouterProvisioning implements OpenRouterProvisioning {
  constructor(
    private readonly provisioningKey: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async createKey({ name, limitUsd }: { name: string; limitUsd: number }): Promise<ProvisionedKey> {
    const body = await this.call('create', 'POST', '/keys', this.provisioningKey, { name, limit: limitUsd });
    const hash = (body.data as { hash?: unknown } | undefined)?.hash;
    if (typeof hash !== 'string' || typeof body.key !== 'string') throw new OpenRouterProvisioningError('create', 502);
    registerSecret(body.key);
    return { hash, key: body.key };
  }

  async updateKey(hash: string, patch: { limitUsd?: number; disabled?: boolean }): Promise<void> {
    await this.call('update', 'PATCH', `/keys/${encodeURIComponent(hash)}`, this.provisioningKey, {
      ...(patch.limitUsd !== undefined ? { limit: patch.limitUsd } : {}),
      ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    });
  }

  async getKeyUsage(subKey: string): Promise<KeyUsage> {
    const body = await this.call('usage', 'GET', '/key', subKey);
    const data = (body.data ?? {}) as Record<string, unknown>;
    return {
      usageUsd: Number(data.usage ?? 0),
      usageMonthlyUsd: Number(data.usage_monthly ?? 0),
      limitUsd: typeof data.limit === 'number' ? data.limit : null,
      disabled: data.disabled === true,
    };
  }

  private async call(operation: string, method: string, path: string, bearer: string, payload?: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok) throw new OpenRouterProvisioningError(operation, response.status);
    return (await response.json()) as Record<string, unknown>;
  }
}

interface FakeKey {
  hash: string; key: string; name: string; limitUsd: number; disabled: boolean; usageUsd: number; usageMonthlyUsd: number;
}

/** In-memory stand-in: tests and local runs without a provisioning key. */
export class InMemoryOpenRouterProvisioning implements OpenRouterProvisioning {
  readonly keys = new Map<string, FakeKey>();

  async createKey({ name, limitUsd }: { name: string; limitUsd: number }): Promise<ProvisionedKey> {
    const hash = `hash-${randomUUID()}`;
    const key = `sk-or-v1-${randomUUID().replace(/-/g, '')}`;
    this.keys.set(hash, { hash, key, name, limitUsd, disabled: false, usageUsd: 0, usageMonthlyUsd: 0 });
    return { hash, key };
  }

  async updateKey(hash: string, patch: { limitUsd?: number; disabled?: boolean }): Promise<void> {
    const entry = this.keys.get(hash);
    if (!entry) throw new OpenRouterProvisioningError('update', 404);
    if (patch.limitUsd !== undefined) entry.limitUsd = patch.limitUsd;
    if (patch.disabled !== undefined) entry.disabled = patch.disabled;
  }

  async getKeyUsage(subKey: string): Promise<KeyUsage> {
    const entry = [...this.keys.values()].find((k) => k.key === subKey);
    if (!entry) throw new OpenRouterProvisioningError('usage', 401);
    return { usageUsd: entry.usageUsd, usageMonthlyUsd: entry.usageMonthlyUsd, limitUsd: entry.limitUsd, disabled: entry.disabled };
  }
}
