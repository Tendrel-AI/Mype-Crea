import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: async (_tenant: unknown, _user: unknown, work: (tx: { query: typeof mocked.query }) => unknown) => work({ query: mocked.query }),
  withTenantAdminTransaction: vi.fn(),
}));

import { RECENT_CONVERSATIONS_LIMIT, businessNameFromAgentStates, conversationsRepo } from '../conversations';

describe('conversationsRepo.ensurePinnedConversation', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  it('returns an existing immutable pin without resolving the current rollout', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT configuration_state, ai_release_id')) {
        return { rows: [{ configuration_state: 'pinned', ai_release_id: 'release-old' }] };
      }
      if (sql.includes('SELECT tenant_id, agent_states, started_at')) {
        return { rows: [{ tenant_id: 'tenant-a', agent_states: {}, started_at: new Date('2026-01-01T00:00:00.000Z') }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const pin = await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).ensurePinnedConversation({
      conversationId: 'conversation-a',
      schemas: [],
    });

    expect(pin).toMatchObject({ state: 'pinned', releaseId: 'release-old' });
    expect(mocked.query).toHaveBeenCalledTimes(2);
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('platform_module_assignments'))).toBe(false);
  });
  it('materializes a platform release only through the narrow helper, never by direct lock or insert', async () => {
    let created = false;
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT configuration_state, ai_release_id')) {
        return { rows: created ? [{ configuration_state: 'pinned', ai_release_id: 'release-platform' }] : [] };
      }
      if (sql.includes('FROM platform_module_assignments')) return { rows: [] };
      if (sql.includes('FROM ai_release_activations')) return { rows: [] };
      if (sql.includes('FROM platform_module_defaults')) return { rows: [{ shared_release_id: 'shared-default' }] };
      if (sql.includes('app.materialize_platform_ai_release')) return { rows: [{ id: 'release-platform' }] };
      if (sql.includes('INSERT INTO conversations')) { created = true; return { rows: [], rowCount: 1 }; }
      if (sql.includes('SELECT tenant_id, agent_states, started_at')) {
        return { rows: [{ tenant_id: 'tenant-a', agent_states: {}, started_at: new Date('2026-01-01T00:00:00.000Z') }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const pin = await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).ensurePinnedConversation({
      conversationId: 'conversation-a',
      schemas: [],
    });

    expect(pin).toMatchObject({ state: 'pinned', releaseId: 'release-platform' });
    const sqls = mocked.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.find((sql) => sql.includes('app.materialize_platform_ai_release'))).toBeDefined();
    expect(mocked.query.mock.calls.find(([sql]) => String(sql).includes('app.materialize_platform_ai_release'))?.[1])
      .toEqual(['shared-default']);
    expect(sqls.some((sql) => /FROM ai_shared_releases/i.test(sql))).toBe(false);
    expect(sqls.some((sql) => /INSERT INTO ai_releases/i.test(sql))).toBe(false);
  });
});

describe('conversationsRepo concurrent state mutations', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  it('locks the owner-visible conversation row before each read-modify-write', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT tenant_id, agent_states, started_at')) {
        return {
          rows: [{
            tenant_id: 'tenant-a',
            agent_states: {
              logo: {
                requiredFields: { business_name: { status: 'empty' } },
                optionalFields: {},
                iterationCount: 0,
              },
            },
            started_at: new Date('2026-01-01T00:00:00.000Z'),
          }],
        };
      }
      if (sql.includes('UPDATE conversations')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const repo = conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' });
    await repo.updateFieldSlot('conversation-a', 'logo', 'business_name', true, {
      status: 'filled', value: 'Tienda Sol', confidence: 1,
    }, []);

    const readSql = String(mocked.query.mock.calls[0][0]);
    expect(readSql).toMatch(/FROM conversations[\s\S]*LIMIT 1\s+FOR UPDATE/i);
    expect(mocked.query.mock.calls[1][0]).toContain('UPDATE conversations');
  });
});

describe('conversationsRepo.readPinnedConversation owner check (KAN-25)', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  it('filters by tenant and owner explicitly, on top of RLS', async () => {
    mocked.query.mockImplementation(async () => ({ rows: [] }));
    const pin = await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' })
      .readPinnedConversation('conversation-a', []);
    expect(pin).toBeUndefined();
    const [sql, params] = mocked.query.mock.calls[0];
    expect(String(sql)).toMatch(/WHERE id = \$1 AND tenant_id = \$2 AND user_id = \$3/);
    expect(params).toEqual(['conversation-a', 'tenant-a', 'user-a']);
    // Not visible → no snapshot read at all.
    expect(mocked.query).toHaveBeenCalledTimes(1);
  });
});

describe('conversationsRepo.listRecent (KAN-25)', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  const filledName = (value: string) => ({
    'logo-agent': {
      requiredFields: { business_name: { status: 'filled', value, confidence: 1 } },
      optionalFields: {},
      iterationCount: 0,
    },
  });

  it('lists only the caller’s pinned conversations by last activity, capped at 20', async () => {
    mocked.query.mockResolvedValue({ rows: [] });
    await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).listRecent();
    const [sql, params] = mocked.query.mock.calls[0];
    const text = String(sql);
    expect(text).toMatch(/c\.tenant_id = \$1\s+AND c\.user_id = \$2/);
    expect(text).toContain(`c.configuration_state = 'pinned'`);
    expect(text).toMatch(/COALESCE\(last_message\.created_at, c\.started_at\) AS last_activity_at/);
    expect(text).toMatch(/m\.tenant_id = c\.tenant_id AND m\.conversation_id = c\.id/);
    expect(text).toMatch(/ORDER BY last_activity_at DESC, c\.id DESC\s+LIMIT \$3/);
    expect(params).toEqual(['tenant-a', 'user-a', RECENT_CONVERSATIONS_LIMIT]);
    expect(RECENT_CONVERSATIONS_LIMIT).toBe(20);
  });

  it.each([[1, 1], [5, 5], [20, 20], [500, 20], [0, 1], [-3, 1]])('bounds limit %d to %d', async (asked, bound) => {
    mocked.query.mockResolvedValue({ rows: [] });
    await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).listRecent(asked);
    expect(mocked.query.mock.calls[0][1]).toEqual(['tenant-a', 'user-a', bound]);
  });

  it('maps rows in database order with ISO dates and the derived business name', async () => {
    mocked.query.mockResolvedValue({
      rows: [
        {
          id: 'conversation-new',
          started_at: new Date('2026-10-20T10:00:00.000Z'),
          last_activity_at: new Date('2026-10-24T15:00:00.000Z'),
          agent_states: filledName('Café Andino'),
        },
        {
          id: 'conversation-old',
          started_at: new Date('2026-10-01T10:00:00.000Z'),
          last_activity_at: new Date('2026-10-01T10:00:00.000Z'),
          agent_states: {},
        },
      ],
    });
    const rows = await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).listRecent();
    expect(rows).toEqual([
      {
        conversationId: 'conversation-new',
        startedAt: '2026-10-20T10:00:00.000Z',
        lastActivityAt: '2026-10-24T15:00:00.000Z',
        businessName: 'Café Andino',
      },
      {
        conversationId: 'conversation-old',
        startedAt: '2026-10-01T10:00:00.000Z',
        lastActivityAt: '2026-10-01T10:00:00.000Z',
        businessName: null,
      },
    ]);
  });
});

describe('businessNameFromAgentStates (KAN-25)', () => {
  it('returns the first filled, non-blank business_name, trimmed', () => {
    expect(businessNameFromAgentStates({
      'logo-agent': { requiredFields: { business_name: { status: 'filled', value: '  Café Andino ', confidence: 1 } }, optionalFields: {} },
    })).toBe('Café Andino');
    expect(businessNameFromAgentStates({
      'a': { requiredFields: { business_name: { status: 'empty' } }, optionalFields: {} },
      'b': { requiredFields: {}, optionalFields: { business_name: { status: 'filled', value: 'Tienda Sol', confidence: 1 } } },
    })).toBe('Tienda Sol');
  });

  it.each([
    ['no states', {}],
    ['null', null],
    ['not an object', 'texto'],
    ['empty slot', { a: { requiredFields: { business_name: { status: 'empty' } } } }],
    ['unconfirmed value', { a: { requiredFields: { business_name: { status: 'pending_confirmation', value: 'Quizá', confidence: 0.5 } } } }],
    ['blank value', { a: { requiredFields: { business_name: { status: 'filled', value: '   ', confidence: 1 } } } }],
    ['non-string value', { a: { requiredFields: { business_name: { status: 'filled', value: 42, confidence: 1 } } } }],
  ])('returns null for %s', (_label, states) => {
    expect(businessNameFromAgentStates(states)).toBeNull();
  });
});

describe('KAN-88 brief <-> brand/product records', () => {
  const when = new Date('2026-01-01T00:00:00.000Z');
  const slot = (value: string) => ({ status: 'filled', value, confidence: 1 });
  const stored = (required: Record<string, unknown>) => ({ logo: { requiredFields: required, optionalFields: {}, iterationCount: 0 } });

  /** Mocked DB: the conversation row, the brand/product rows and every write. */
  function db(opts: {
    states: Record<string, unknown>;
    brandId?: string | null;
    productId?: string | null;
    brand?: Record<string, unknown>;
    brandStatus?: string;
    product?: Record<string, unknown>;
  }) {
    const updates: { sql: string; params: unknown[] }[] = [];
    mocked.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT tenant_id, agent_states, started_at')) {
        return { rows: [{ tenant_id: 't', user_id: 'u', agent_states: opts.states, brand_id: opts.brandId ?? null, product_id: opts.productId ?? null, started_at: when }] };
      }
      if (sql.includes('SELECT b.attributes AS brand_attributes')) {
        return { rows: [{ brand_attributes: opts.brand ?? {}, product_attributes: opts.productId ? opts.product ?? {} : null }] };
      }
      if (sql.includes('UPDATE conversations')) {
        return { rowCount: 1, rows: [{ previous_states: opts.states, tenant_id: 't', user_id: 'u', brand_id: opts.brandId ?? null, product_id: opts.productId ?? null }] };
      }
      if (sql.includes('FROM brands') && sql.includes('FOR UPDATE')) return { rows: [{ attributes: opts.brand ?? {}, status: opts.brandStatus ?? 'active' }] };
      if (sql.includes('FROM products') && sql.includes('FOR UPDATE')) return { rows: [{ attributes: opts.product ?? {} }] };
      if (/^UPDATE (brands|products)/.test(sql.trim())) { updates.push({ sql, params }); return { rowCount: 1, rows: [] }; }
      return { rows: [] };
    });
    return { updates };
  }
  const repo = () => conversationsRepo({ id: 't' }, { id: 'u' });
  const schemas = [{ agentId: 'logo', requiredFields: ['business_name', 'business_category', 'product_name', 'product_description'], optionalFields: [] }];
  const setSlot = (field: string, value: string) =>
    repo().updateFieldSlot('c', 'logo', field, true, slot(value) as never, schemas as never);

  beforeEach(() => { mocked.query.mockReset(); });

  it('overlays record values as filled slots, record wins over stored, pending becomes filled', async () => {
    db({
      brandId: 'b',
      brand: { business_name: 'Dulce', business_category: 'Panadería' },
      states: stored({ business_name: { status: 'pending_confirmation', value: 'Otro', confidence: 0.7 }, business_category: slot('Viejo'), product_name: { status: 'empty' } }),
    });
    const snap = await repo().get('c', schemas as never);
    const slots = snap!.agentStates.logo.requiredFields;
    expect(slots.business_name).toMatchObject({ status: 'filled', value: 'Dulce' });
    expect(slots.business_category).toMatchObject({ status: 'filled', value: 'Panadería' });
    expect(slots.product_name).toEqual({ status: 'empty' });
  });

  it('leaves a legacy conversation untouched (no record read)', async () => {
    db({ states: stored({ business_name: slot('Stored') }) });
    const snap = await repo().get('c', schemas as never);
    expect(snap!.agentStates.logo.requiredFields.business_name).toEqual(slot('Stored'));
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('FROM brands'))).toBe(false);
  });

  it('writes a confirmed value back to the brand (and name) in the same transaction', async () => {
    const { updates } = db({ brandId: 'b', brand: { business_category: 'Viejo' }, states: stored({ business_name: { status: 'empty' } }) });
    await setSlot('business_name', 'Dulce Andino');
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('UPDATE brands');
    expect(JSON.parse(String(updates[0].params[4]))).toEqual({ business_category: 'Viejo', business_name: 'Dulce Andino' });
    expect(updates[0].params[3]).toBe('Dulce Andino');
  });

  it('does not write back unchanged values, pending values or unmapped fields', async () => {
    const { updates } = db({ brandId: 'b', brand: { business_category: 'Café' }, states: stored({ business_category: slot('Café') }) });
    await setSlot('business_category', 'Café');
    await repo().updateFieldSlot('c', 'logo', 'business_name', true, { status: 'pending_confirmation', value: 'X', confidence: 0.7 }, schemas as never);
    await setSlot('product_description', 'texto local');
    expect(updates).toEqual([]);
  });

  it('skips an invalid write-back without throwing, and the brief still updates', async () => {
    const { updates } = db({ brandId: 'b', states: stored({}) });
    await expect(setSlot('business_category', 'x'.repeat(130))).resolves.toBeUndefined();
    expect(updates).toEqual([]);
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE conversations'))).toBe(true);
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('ROLLBACK TO SAVEPOINT'))).toBe(false);
  });

  it('rolls back to the savepoint when the record write fails, without failing the turn', async () => {
    db({ brandId: 'b', states: stored({}) });
    const inner = mocked.query.getMockImplementation()!;
    mocked.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/^UPDATE brands/.test(sql.trim())) throw new Error('boom');
      return inner(sql, params);
    });
    await expect(setSlot('business_category', 'Café')).resolves.toBeUndefined();
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('ROLLBACK TO SAVEPOINT'))).toBe(true);
  });

  it('overlays an archived brand but never writes back to it', async () => {
    const { updates } = db({ brandId: 'b', brandStatus: 'archived', brand: { business_name: 'Vieja' }, states: stored({ business_name: { status: 'empty' } }) });
    expect((await repo().get('c', schemas as never))!.agentStates.logo.requiredFields.business_name).toMatchObject({ value: 'Vieja' });
    await setSlot('business_category', 'Café');
    expect(updates).toEqual([]);
  });

  it('writes product fields to the product only in a product conversation', async () => {
    const brandConversation = db({ brandId: 'b', states: stored({}) });
    await setSlot('product_name', 'Molido');
    expect(brandConversation.updates).toEqual([]);

    const productConversation = db({ brandId: 'b', productId: 'p', states: stored({}) });
    await setSlot('product_name', 'Molido');
    expect(productConversation.updates).toHaveLength(1);
    expect(productConversation.updates[0].sql).toContain('UPDATE products');
    expect(productConversation.updates[0].params[3]).toBe('Molido');
  });

  it('locks the brand before the product', async () => {
    db({ brandId: 'b', productId: 'p', states: stored({}) });
    await setSlot('business_category', 'Café');
    const sqls = mocked.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.findIndex((s) => s.includes('FROM brands') && s.includes('FOR UPDATE')))
      .toBeLessThan(sqls.findIndex((s) => s.includes('FROM products') && s.includes('FOR UPDATE')));
  });
});

describe('conversationsRepo.latestBrandConversationId (D34)', () => {
  beforeEach(() => mocked.query.mockReset());

  it('looks up the owner\'s brand-level conversation directly, scoped by tenant, owner and brand', async () => {
    mocked.query.mockResolvedValue({ rows: [{ id: 'brand-chat' }] });
    const id = await conversationsRepo({ id: 'tenant-a' }, { id: 'user-a' }).latestBrandConversationId('brand-a');
    expect(id).toBe('brand-chat');
    const [sql, params] = mocked.query.mock.calls[0];
    expect(String(sql)).toMatch(/tenant_id = \$1 AND user_id = \$2 AND brand_id = \$3 AND product_id IS NULL/);
    expect(params).toEqual(['tenant-a', 'user-a', 'brand-a']);
  });

  it('undefined when the brand has no brand conversation', async () => {
    mocked.query.mockResolvedValue({ rows: [] });
    expect(await conversationsRepo({ id: 't' }, { id: 'u' }).latestBrandConversationId('b')).toBeUndefined();
  });
});
