/**
 * Conversations repository. Reads/writes the conversations row and its
 * `agent_states` JSONB column (the persisted form of the orchestrator's
 * ConversationSnapshot.agentStates).
 *
 * Per docs/agents/database.md: every method runs inside an explicit
 * transaction with the tenant + user GUCs set. There is no overload that
 * skips the tenant. Application code never imports this file directly —
 * it goes through `repos(tenant, user)` (see ./index.ts).
 */
import type {
  AgentId,
  AgentRequirementState,
  ConversationId,
  ConversationSnapshot,
  FieldName,
  FieldSlot,
  TaskId,
  UUID,
} from '../core/contracts';
import type { AiConversationPin, RecentConversationRow } from './models';
import type { AgentFieldSchema } from '../core/orchestrator/in-memory-store';
import {
  withTenantAdminTransaction,
  withTenantTransaction,
  type Tenant,
  type TxClient,
  type User,
} from '../db/with-transaction';

type AgentStatesJson = Record<AgentId, AgentRequirementState>;

function emptySlots(names: ReadonlyArray<FieldName>): Record<FieldName, FieldSlot> {
  const out: Record<FieldName, FieldSlot> = {};
  for (const n of names) out[n] = { status: 'empty' };
  return out;
}

function buildEmptyAgentStates(schemas: ReadonlyArray<AgentFieldSchema>): AgentStatesJson {
  const states: AgentStatesJson = {};
  for (const s of schemas) {
    states[s.agentId] = {
      requiredFields: emptySlots(s.requiredFields),
      optionalFields: emptySlots(s.optionalFields),
      iterationCount: 0,
    };
  }
  return states;
}

/**
 * Resolve a new conversation's release: organization module assignment, else the tenant's
 * active local release, else the global module default. Platform releases are materialized
 * as tenant-local copies by `app.materialize_platform_ai_release` (migration 1792640000000).
 */
async function resolveNewConversationRelease(tx: TxClient, tenant: Tenant): Promise<string | undefined> {
  const assignment = await tx.query<{ readonly shared_release_id: string | null }>(
    `SELECT v.shared_release_id
       FROM platform_module_assignments a
       JOIN platform_module_versions v
         ON v.module_id = a.module_id AND v.version = a.version
      WHERE a.module_id = 'ai' AND a.organization_id = $1
      LIMIT 1`,
    [tenant.id],
  );
  let config = assignment.rows[0];
  // Existing tenant activation remains an explicit tenant choice until a platform rollout
  // writes an organization assignment. A global default serves new/unconfigured organizations.
  if (!config) {
    const activation = await tx.query<{ readonly release_id: string }>(
      `SELECT a.release_id
         FROM ai_release_activations a
         JOIN ai_releases r ON r.tenant_id = a.tenant_id AND r.id = a.release_id
        WHERE a.tenant_id = $1 AND r.status = 'frozen'
        FOR SHARE OF a, r`,
      [tenant.id],
    );
    if (activation.rows[0]) return activation.rows[0].release_id;
    const defaultConfig = await tx.query<{ readonly shared_release_id: string | null }>(
      `SELECT v.shared_release_id
         FROM platform_module_defaults d
         JOIN platform_module_versions v ON v.module_id = d.module_id AND v.version = d.version
        WHERE d.module_id = 'ai'
        LIMIT 1`,
    );
    config = defaultConfig.rows[0];
  }
  if (config?.shared_release_id) {
    // Tenant users cannot row-lock shared releases or insert tenant releases under RLS
    // (KAN-77). The narrow definer helper re-derives the effective platform release for the
    // current tenant, refuses any other id, and copies it as an immutable local release.
    const materialized = await tx.query<{ readonly id: string | null }>(
      `SELECT app.materialize_platform_ai_release($1) AS id`,
      [config.shared_release_id],
    );
    const releaseId = materialized.rows[0]?.id;
    if (!releaseId) throw new Error('La versión compartida de IA ya no está disponible.');
    return releaseId;
  }

  return undefined;
}

/**
 * Load the agent_states JSONB and reify it into a snapshot. Schemas are
 * needed to fill in defaults for agents present in the registry but missing
 * from the JSONB (e.g. an agent added after this conversation started).
 */
async function loadSnapshot(
  tx: TxClient,
  conversationId: ConversationId,
  schemas: ReadonlyArray<AgentFieldSchema>,
  lockForUpdate = false,
): Promise<ConversationSnapshot | undefined> {
  const res = await tx.query<{
    tenant_id: string;
    agent_states: AgentStatesJson;
    started_at: Date;
  }>(
    `SELECT tenant_id, agent_states, started_at
       FROM conversations
      WHERE id = $1
      LIMIT 1
      ${lockForUpdate ? 'FOR UPDATE' : ''}`,
    [conversationId],
  );
  if (res.rows.length === 0) return undefined;
  const row = res.rows[0];

  // Merge schema defaults so newly-registered agents appear with empty slots.
  const defaults = buildEmptyAgentStates(schemas);
  const merged: AgentStatesJson = { ...defaults, ...row.agent_states };

  return {
    conversationId,
    tenantId: row.tenant_id,
    agentStates: merged,
    updatedAt: row.started_at.toISOString(),
  };
}

/** Brief field that names the business; every live agent card requires it. */
export const BUSINESS_NAME_FIELD: FieldName = 'business_name';

/** Upper bound of the recent-conversations list (KAN-25, owner decision: latest 20). */
export const RECENT_CONVERSATIONS_LIMIT = 20;

/**
 * The business name from a persisted `agent_states` JSONB: the first `filled`
 * `business_name` slot (required or optional) with a non-blank string value.
 * Unconfirmed (`pending_confirmation`) values are not used as a title.
 */
export function businessNameFromAgentStates(agentStates: unknown): string | null {
  if (!agentStates || typeof agentStates !== 'object') return null;
  for (const state of Object.values(agentStates as Record<string, unknown>)) {
    if (!state || typeof state !== 'object') continue;
    for (const sliceKey of ['requiredFields', 'optionalFields'] as const) {
      const slice = (state as Record<string, unknown>)[sliceKey];
      if (!slice || typeof slice !== 'object') continue;
      const slot = (slice as Record<string, unknown>)[BUSINESS_NAME_FIELD] as
        | { status?: unknown; value?: unknown }
        | undefined;
      if (slot?.status === 'filled' && typeof slot.value === 'string' && slot.value.trim()) {
        return slot.value.trim();
      }
    }
  }
  return null;
}

async function writeAgentStates(
  tx: TxClient,
  conversationId: ConversationId,
  agentStates: AgentStatesJson,
): Promise<void> {
  const res = await tx.query(
    `UPDATE conversations
        SET agent_states = $2::jsonb
      WHERE id = $1`,
    [conversationId, JSON.stringify(agentStates)],
  );
  if (res.rowCount === 0) {
    throw new Error(`No conversation row to update: ${conversationId}`);
  }
}

export function conversationsRepo(tenant: Tenant, user: User) {
  return {
    /**
     * Create a new conversation pinned to the current tenant activation in the
     * same transaction. Existing legacy rows remain unversioned forever.
     */
    async ensurePinnedConversation(input: {
      readonly conversationId: ConversationId;
      readonly schemas: ReadonlyArray<AgentFieldSchema>;
    }): Promise<AiConversationPin> {
      return withTenantTransaction(tenant, user, async (tx) => {
        let pinned = await tx.query<{
          configuration_state: 'pinned' | 'legacy_unversioned';
          ai_release_id: UUID | null;
        }>(
          `SELECT configuration_state, ai_release_id
             FROM conversations
            WHERE id = $1 AND tenant_id = $2 AND user_id = $3
            LIMIT 1`,
          [input.conversationId, tenant.id, user.id],
        );
        if (!pinned.rows[0]) {
          const resolvedReleaseId = await resolveNewConversationRelease(tx, tenant);
          await tx.query(
            `INSERT INTO conversations
               (id, tenant_id, user_id, ai_release_id, configuration_state)
             SELECT $1, $2, $3, $4, 'pinned'
              WHERE $4::uuid IS NOT NULL
             ON CONFLICT (id) DO NOTHING`,
            [input.conversationId, tenant.id, user.id, resolvedReleaseId ?? null],
          );
          pinned = await tx.query<{
            configuration_state: 'pinned' | 'legacy_unversioned';
            ai_release_id: UUID | null;
          }>(
            `SELECT configuration_state, ai_release_id
               FROM conversations
              WHERE id = $1 AND tenant_id = $2 AND user_id = $3
              LIMIT 1`,
            [input.conversationId, tenant.id, user.id],
          );
        }
        if (!pinned.rows[0]) {
          throw new Error('No hay una configuración activa para iniciar una conversación nueva.');
        }

        const snapshot = await loadSnapshot(tx, input.conversationId, input.schemas);
        if (!snapshot) throw new Error(`Conversation row not visible: ${input.conversationId}`);
        const state = pinned.rows[0].configuration_state;
        const pinnedReleaseId = pinned.rows[0].ai_release_id;
        if (state === 'pinned' && !pinnedReleaseId) {
          throw new Error(`Pinned conversation has no release: ${input.conversationId}`);
        }
        return {
          conversationId: input.conversationId,
          state,
          releaseId: pinnedReleaseId,
          snapshot,
        };
      });
    },

    /**
     * Read the pin for the caller's own conversation without changing it.
     * RLS already hides foreign rows; the explicit tenant + owner predicate is the
     * application-level owner check (KAN-25), so a foreign id is indistinguishable
     * from a missing one.
     */
    async readPinnedConversation(
      conversationId: ConversationId,
      schemas: ReadonlyArray<AgentFieldSchema>,
    ): Promise<AiConversationPin | undefined> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const row = await tx.query<{
          configuration_state: 'pinned' | 'legacy_unversioned';
          ai_release_id: UUID | null;
        }>(
          `SELECT configuration_state, ai_release_id
             FROM conversations
            WHERE id = $1 AND tenant_id = $2 AND user_id = $3
            LIMIT 1`,
          [conversationId, tenant.id, user.id],
        );
        if (!row.rows[0]) return undefined;
        const snapshot = await loadSnapshot(tx, conversationId, schemas);
        if (!snapshot) return undefined;
        return {
          conversationId,
          state: row.rows[0].configuration_state,
          releaseId: row.rows[0].ai_release_id,
          snapshot,
        };
      });
    },

    /**
     * The caller's own pinned conversations, newest activity first (KAN-25).
     * Last activity = newest message `created_at`, else `started_at`. Legacy
     * unversioned rows are never returned. Ties break on id so the order is stable.
     * The explicit tenant + owner predicate duplicates RLS on purpose.
     */
    async listRecent(limit: number = RECENT_CONVERSATIONS_LIMIT): Promise<RecentConversationRow[]> {
      const bounded = Math.max(1, Math.min(Math.trunc(limit) || 1, RECENT_CONVERSATIONS_LIMIT));
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{
          id: ConversationId;
          started_at: Date;
          last_activity_at: Date;
          agent_states: unknown;
        }>(
          `SELECT c.id, c.started_at, c.agent_states,
                  COALESCE(last_message.created_at, c.started_at) AS last_activity_at
             FROM conversations c
             LEFT JOIN LATERAL (
               SELECT m.created_at
                 FROM messages m
                WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
                ORDER BY m.created_at DESC
                LIMIT 1
             ) last_message ON true
            WHERE c.tenant_id = $1
              AND c.user_id = $2
              AND c.configuration_state = 'pinned'
            ORDER BY last_activity_at DESC, c.id DESC
            LIMIT $3`,
          [tenant.id, user.id, bounded],
        );
        return res.rows.map((row) => ({
          conversationId: row.id,
          startedAt: row.started_at.toISOString(),
          lastActivityAt: row.last_activity_at.toISOString(),
          businessName: businessNameFromAgentStates(row.agent_states),
        }));
      });
    },

    /**
     * Ensure a conversations row exists for (tenant, user, conversationId).
     * Returns the snapshot built from the persisted `agent_states` (or freshly
     * defaulted if the row was just created).
     */
    async getOrCreate(
      conversationId: ConversationId,
      schemas: ReadonlyArray<AgentFieldSchema>,
    ): Promise<ConversationSnapshot> {
      return withTenantTransaction(tenant, user, async (tx) => {
        // Idempotent insert. RLS WITH CHECK enforces tenant_id matches the GUC.
        await tx.query(
          `INSERT INTO conversations (id, tenant_id, user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO NOTHING`,
          [conversationId, tenant.id, user.id],
        );
        const snap = await loadSnapshot(tx, conversationId, schemas);
        if (!snap) throw new Error(`Insert succeeded but row not visible: ${conversationId}`);
        return snap;
      });
    },

    async get(
      conversationId: ConversationId,
      schemas: ReadonlyArray<AgentFieldSchema>,
    ): Promise<ConversationSnapshot | undefined> {
      return withTenantTransaction(tenant, user, async (tx) =>
        loadSnapshot(tx, conversationId, schemas),
      );
    },

    async updateFieldSlot(
      conversationId: ConversationId,
      agentId: AgentId,
      fieldName: FieldName,
      isRequired: boolean,
      slot: FieldSlot,
      schemas: ReadonlyArray<AgentFieldSchema>,
    ): Promise<void> {
      await withTenantTransaction(tenant, user, async (tx) => {
        // Serialize read-modify-write mutations on the owner-visible row. Under
        // READ COMMITTED, a waiter sees the preceding transaction's committed
        // JSONB before applying its own mutation.
        const snap = await loadSnapshot(tx, conversationId, schemas, true);
        if (!snap) throw new Error(`Unknown conversation: ${conversationId}`);
        const current = snap.agentStates[agentId];
        if (!current) throw new Error(`Unknown agent in snapshot: ${agentId}`);
        const sliceKey = isRequired ? 'requiredFields' : 'optionalFields';
        const next: AgentRequirementState = {
          ...current,
          [sliceKey]: { ...current[sliceKey], [fieldName]: slot },
        };
        const nextStates: AgentStatesJson = { ...snap.agentStates, [agentId]: next };
        await writeAgentStates(tx, conversationId, nextStates);
      });
    },

    async recordDispatch(
      conversationId: ConversationId,
      agentId: AgentId,
      taskId: TaskId,
      schemas: ReadonlyArray<AgentFieldSchema>,
    ): Promise<void> {
      await withTenantTransaction(tenant, user, async (tx) => {
        const snap = await loadSnapshot(tx, conversationId, schemas, true);
        if (!snap) throw new Error(`Unknown conversation: ${conversationId}`);
        const current = snap.agentStates[agentId];
        if (!current) throw new Error(`Unknown agent in snapshot: ${agentId}`);
        const next: AgentRequirementState = {
          ...current,
          lastDispatchedTaskId: taskId,
          iterationCount: current.iterationCount + 1,
        };
        const nextStates: AgentStatesJson = { ...snap.agentStates, [agentId]: next };
        await writeAgentStates(tx, conversationId, nextStates);
      });
    },

    async clearDispatch(
      conversationId: ConversationId,
      agentId: AgentId,
      schemas: ReadonlyArray<AgentFieldSchema>,
    ): Promise<void> {
      await withTenantTransaction(tenant, user, async (tx) => {
        const snap = await loadSnapshot(tx, conversationId, schemas, true);
        if (!snap) throw new Error(`Unknown conversation: ${conversationId}`);
        const current = snap.agentStates[agentId];
        if (!current) throw new Error(`Unknown agent in snapshot: ${agentId}`);
        const { lastDispatchedTaskId: _drop, ...rest } = current;
        const nextStates: AgentStatesJson = {
          ...snap.agentStates,
          [agentId]: rest as AgentRequirementState,
        };
        await writeAgentStates(tx, conversationId, nextStates);
      });
    },
  };
}

export type ConversationsRepo = ReturnType<typeof conversationsRepo>;

/**
 * System-scoped lookup: read the owning user_id of a conversation under a
 * tenant. Used by background workers (no User in scope) that need to scope
 * a subsequent user-bound write — e.g. the logo-agent worker needs the
 * owner's user_id to insert into `deliverables` (tenant + user RLS).
 *
 * Runs under tenant-admin so the user-axis check is bypassed for this read.
 */
export async function getConversationOwnerUserId(
  tenant: Tenant,
  conversationId: ConversationId,
): Promise<UUID | null> {
  return withTenantAdminTransaction(tenant, async (tx) => {
    const res = await tx.query<{ user_id: UUID }>(
      `SELECT user_id FROM conversations WHERE id = $1 LIMIT 1`,
      [conversationId],
    );
    return res.rows.length > 0 ? res.rows[0].user_id : null;
  });
}
