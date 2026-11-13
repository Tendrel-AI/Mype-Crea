import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HttpOpenRouterProvisioning, InMemoryOpenRouterProvisioning, keyLimitFor } from '../provisioning';
import { TenantKeyService, type TenantKeyStore } from '../tenant-keys';
import { createProviderKeyCipher } from '../../secrets/provider-key-cipher';

const TENANT = '11111111-1111-1111-1111-111111111111';

type Init = { method: string; headers: Record<string, string>; body?: string };

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ url: string } & Init> = [];
  const fetchImpl = vi.fn(async (url: string, init: Init) => {
    calls.push({ url, ...init });
    return { ok: true, status: 200, json: async () => responses.shift() };
  });
  return { fetchImpl, calls };
}

describe('HttpOpenRouterProvisioning', () => {
  it('creates a key named after the tenant with the limit, using the provisioning key', async () => {
    const { fetchImpl, calls } = fakeFetch([{ data: { hash: 'h1' }, key: 'sk-or-v1-secret-value' }]);
    const key = await new HttpOpenRouterProvisioning('prov-key', fetchImpl).createKey({ name: TENANT, limitUsd: 5 });
    expect(key).toEqual({ hash: 'h1', key: 'sk-or-v1-secret-value' });
    expect(calls[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/keys', method: 'POST', headers: { Authorization: 'Bearer prov-key' } });
    expect(JSON.parse(calls[0].body!)).toEqual({ name: TENANT, limit: 5 });
  });

  it('raises the limit, disables, and reads usage with the sub-key', async () => {
    const { fetchImpl, calls } = fakeFetch([{}, {}, { data: { usage: 1.5, usage_monthly: 0.5, limit: 6.5 } }]);
    const http = new HttpOpenRouterProvisioning('prov-key', fetchImpl);
    await http.updateKey('h1', { limitUsd: 9 });
    await http.updateKey('h1', { disabled: true });
    expect(await http.getKeyUsage('sub-key')).toMatchObject({ usageUsd: 1.5, usageMonthlyUsd: 0.5, limitUsd: 6.5 });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PATCH', 'https://openrouter.ai/api/v1/keys/h1'],
      ['PATCH', 'https://openrouter.ai/api/v1/keys/h1'],
      ['GET', 'https://openrouter.ai/api/v1/key'],
    ]);
    expect(JSON.parse(calls[0].body!)).toEqual({ limit: 9 });
    expect(JSON.parse(calls[1].body!)).toEqual({ disabled: true });
    expect(calls[2].headers.Authorization).toBe('Bearer sub-key');
  });

  it('throws a typed error on refusal', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(new HttpOpenRouterProvisioning('prov-key', fetchImpl).updateKey('h', {})).rejects.toThrow('HTTP 401');
  });
});

describe('keyLimitFor', () => {
  it('makes remaining = balance by adding what the key already spent; never below spend', () => {
    expect(keyLimitFor(5, 2)).toBe(7);
    expect(keyLimitFor(-1, 2)).toBe(2);
  });
});

function harness() {
  const balance = { usd: 5 };
  const rows = new Map<string, { tenantId: string; keyCiphertext: string; keyHash: string; limitUsd: number; status: 'active' | 'disabled' }>();
  const store: TenantKeyStore = {
    balance: async () => balance.usd,
    findKey: async (id) => rows.get(id),
    insertKey: async (_actor, key) => {
      if (rows.has(key.tenantId)) return false;
      rows.set(key.tenantId, key);
      return true;
    },
    updateKey: async (id, patch) => {
      const row = rows.get(id)!;
      rows.set(id, { ...row, ...(patch.limitUsd !== undefined ? { limitUsd: patch.limitUsd } : {}), ...(patch.status ? { status: patch.status } : {}) });
    },
    openRouterConsumptionByMonth: async () => [{ month: new Date().toISOString().slice(0, 7), usd: 1.25 }],
  };
  const provisioning = new InMemoryOpenRouterProvisioning();
  const cipher = createProviderKeyCipher(randomBytes(32));
  let now = Date.now();
  const service = new TenantKeyService(store, provisioning, () => cipher, () => now);
  const remote = () => [...provisioning.keys.values()][0];
  return { service, provisioning, rows, balance, remote, advance: (ms: number) => { now += ms; } };
}

describe('TenantKeyService', () => {
  it('creates one encrypted sub-key per tenant (idempotent) at cost-basis limit', async () => {
    const h = harness();
    expect(await h.service.ensureKey(TENANT, 'user_a')).toBe(true);
    expect(await h.service.ensureKey(TENANT, 'user_a')).toBe(false);
    expect(h.provisioning.keys.size).toBe(1);
    expect(h.remote()).toMatchObject({ name: TENANT, limitUsd: 5, disabled: false });
    expect(h.rows.get(TENANT)!.keyCiphertext).not.toContain(h.remote().key);
    expect(await h.service.resolveKey(TENANT)).toBe(h.remote().key);
  });

  it('raises the limit after a recharge, accounting for key usage', async () => {
    const h = harness();
    await h.service.ensureKey(TENANT, 'user_a');
    h.remote().usageUsd = 2;
    h.balance.usd = 8;
    await h.service.syncLimit(TENANT);
    expect(h.remote().limitUsd).toBe(10);
    expect(h.rows.get(TENANT)!.limitUsd).toBe(10);
  });

  it('disables on suspension (no key resolves) and re-enables with a fresh limit', async () => {
    const h = harness();
    await h.service.ensureKey(TENANT, 'user_a');
    await h.service.setEnabled(TENANT, false);
    expect(h.remote().disabled).toBe(true);
    expect(await h.service.resolveKey(TENANT)).toBeUndefined();
    h.balance.usd = 9;
    await h.service.syncLimit(TENANT);
    expect(h.remote().limitUsd).toBe(5); // a disabled key is left alone
    await h.service.setEnabled(TENANT, true);
    expect(h.remote().disabled).toBe(false);
    expect(h.remote().limitUsd).toBe(9);
  });

  it('throttles the post-settlement sync', async () => {
    const h = harness();
    await h.service.ensureKey(TENANT, 'user_a');
    const update = vi.spyOn(h.provisioning, 'updateKey');
    h.service.scheduleSync(TENANT);
    h.service.scheduleSync(TENANT);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    h.advance(6 * 60_000);
    h.service.scheduleSync(TENANT);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  });

  it('reconciles ledger consumption against the key usage of the current month', async () => {
    const h = harness();
    await h.service.ensureKey(TENANT, 'user_a');
    h.remote().usageUsd = 1.3;
    h.remote().usageMonthlyUsd = 1.3;
    const result = await h.service.reconcile('user_a', TENANT);
    expect(result).toMatchObject({ hasKey: true, totalLedgerUsd: 1.25, totalKeyUsageUsd: 1.3, totalDifferenceUsd: -0.05 });
    expect(result.months[0]).toMatchObject({ ledgerUsd: 1.25, keyUsageUsd: 1.3, differenceUsd: -0.05 });
  });
});
