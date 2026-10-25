/**
 * Integration test for the llm_calls repository.
 *
 * Skipped if APP_DATABASE_URL is not set (so the unit suite stays fast).
 * Each test inserts under the seeded pilot tenant + user and cleans up
 * after itself; conversation rows are deleted, which doesn't cascade to
 * llm_calls (FK is ON DELETE SET NULL there) — we delete llm_calls
 * explicitly via the superuser bootstrap connection.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { closePool } from '../../db/pool';
import { repos, systemRepos } from '..';
import type { UUID } from '../../core/contracts';

const SUITE = process.env.APP_DATABASE_URL ? describe : describe.skip;

async function fetchPilotIds(): Promise<{ tenantId: UUID; userId: UUID }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set for the integration test bootstrap');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tenant = await client.query<{ id: string }>(
      `SELECT id FROM tenants WHERE name = 'Pilot Institution' LIMIT 1`,
    );
    const tenantId = tenant.rows[0].id;
    const user = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
      [tenantId],
    );
    return { tenantId, userId: user.rows[0].id };
  } finally {
    await client.end();
  }
}

async function withOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set for the integration test bootstrap');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function deleteLlmCall(id: UUID): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DELETE FROM llm_calls WHERE id = $1`, [id]);
  } finally {
    await client.end();
  }
}

SUITE('llm_calls repository (integration)', () => {
  let tenantId: UUID;
  let userId: UUID;
  const insertedIds: UUID[] = [];

  beforeAll(async () => {
    const ids = await fetchPilotIds();
    tenantId = ids.tenantId;
    userId = ids.userId;
  });

  afterEach(async () => {
    while (insertedIds.length > 0) {
      const id = insertedIds.pop()!;
      await deleteLlmCall(id);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('records an llm_call attributed to a user', async () => {
    const r = repos({ id: tenantId }, { id: userId });
    const id = await r.llmCalls.record({
      provider: 'openrouter',
      purpose: 'responder',
      model: 'google/gemini-2.5-pro',
      modelRevision: 'unknown',
      promptVersion: 'test.v1',
      inputTokens: 123,
      outputTokens: 456,
      latencyMs: 789,
    });
    insertedIds.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records an unattributed system llm_call (user_id NULL)', async () => {
    const sys = systemRepos({ id: tenantId });
    const id = await sys.llmCalls.record({
      provider: 'openrouter',
      purpose: 'responder',
      model: 'google/gemini-2.5-pro',
      modelRevision: 'unknown',
      promptVersion: 'test.v1',
      inputTokens: 1,
      outputTokens: 2,
      latencyMs: 3,
    });
    insertedIds.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('persists the effective provider, purpose, model and tokens (KAN-69 A6)', async () => {
    const r = repos({ id: tenantId }, { id: userId });
    const id = await r.llmCalls.record({
      provider: 'anthropic',
      purpose: 'extractor',
      model: 'claude-haiku-5-5',
      modelRevision: 'unknown',
      promptVersion: 'test.v1',
      inputTokens: 12,
      outputTokens: 4,
      latencyMs: 5,
    });
    insertedIds.push(id);
    const row = await withOwner(async (client) => (await client.query(
      `SELECT tenant_id, user_id, provider, purpose, model, input_tokens, output_tokens
         FROM llm_calls WHERE id = $1`,
      [id],
    )).rows[0]);
    expect(row).toEqual({
      tenant_id: tenantId,
      user_id: userId,
      provider: 'anthropic',
      purpose: 'extractor',
      model: 'claude-haiku-5-5',
      input_tokens: 12,
      output_tokens: 4,
    });
  });

  it('rejects unknown provider or purpose values and new rows without provenance', async () => {
    const insert = (provider: string | null, purpose: string | null) => withOwner((client) => client.query(
      `INSERT INTO llm_calls
         (tenant_id, provider, purpose, model, model_revision, prompt_version,
          input_tokens, output_tokens, latency_ms)
       VALUES ($1, $2, $3, 'm', 'unknown', 'test.v1', 0, 0, 0)`,
      [tenantId, provider, purpose],
    ));
    await expect(insert('openai', 'extractor')).rejects.toThrow(/llm_calls_provider_check/);
    await expect(insert('openrouter', 'judge')).rejects.toThrow(/llm_calls_purpose_check/);
    await expect(insert(null, 'responder')).rejects.toThrow(/llm_calls_provenance_required/);
    await expect(insert('anthropic', null)).rejects.toThrow(/llm_calls_provenance_required/);
  });

  it('rejects writes for a foreign tenant via RLS WITH CHECK', async () => {
    // Insert from a tenant id we don't own. RLS WITH CHECK should reject.
    const fakeTenantId = randomUUID();
    const r = repos({ id: fakeTenantId }, { id: userId });
    await expect(
      r.llmCalls.record({
        provider: 'openrouter',
        purpose: 'extractor',
        model: 'google/gemini-2.5-pro',
        modelRevision: 'unknown',
        promptVersion: 'test.v1',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      }),
    ).rejects.toThrow();
  });
});
