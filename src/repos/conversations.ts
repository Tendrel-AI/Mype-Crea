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
import type { AiConversationPin } from './models';
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
 * Load the agent_states JSONB and reify it into a snapshot. Schemas are
 * needed to fill in defaults for agents present in the registry but missing
 * from the JSONB (e.g. an agent added after this conversation started).
 */
async function loadSnapshot(
  tx: TxClient,
  conversationId: ConversationId,
  schemas: ReadonlyArray<AgentFieldSchema>,
): Promise<ConversationSnapshot | undefined> {
  const res = await tx.query<{
    tenant_id: string;
    agent_states: AgentStatesJson;
    started_at: Date;
  }>(
    `SELECT tenant_id, agent_states, started_at
       FROM conversations
      WHERE id = $1
      LIMIT 1`,
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
        await tx.query(
          `INSERT INTO conversations
             (id, tenant_id, user_id, ai_release_id, configuration_state)
           SELECT $1, $2, $3, a.release_id, 'pinned'
             FROM ai_release_activations a
             JOIN ai_releases r
               ON r.tenant_id = a.tenant_id
              AND r.id = a.release_id
            WHERE a.tenant_id = $2
              AND r.status = 'frozen'
            FOR SHARE OF a, r
           ON CONFLICT (id) DO NOTHING`,
          [input.conversationId, tenant.id, user.id],
        );

        const row = await tx.query<{
          configuration_state: 'pinned' | 'legacy_unversioned';
          ai_release_id: UUID | null;
        }>(
          `SELECT configuration_state, ai_release_id
             FROM conversations
            WHERE id = $1
            LIMIT 1`,
          [input.conversationId],
        );
        if (!row.rows[0]) {
          throw new Error('No hay una configuración activa para iniciar una conversación nueva.');
        }

        const snapshot = await loadSnapshot(tx, input.conversationId, input.schemas);
        if (!snapshot) throw new Error(`Conversation row not visible: ${input.conversationId}`);
        const state = row.rows[0].configuration_state;
        const releaseId = row.rows[0].ai_release_id;
        if (state === 'pinned' && !releaseId) {
          throw new Error(`Pinned conversation has no release: ${input.conversationId}`);
        }
        return {
          conversationId: input.conversationId,
          state,
          releaseId,
          snapshot,
        };
      });
    },

    /** Read the pin for the caller's own conversation without changing it. */
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
            WHERE id = $1
            LIMIT 1`,
          [conversationId],
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
        const snap = await loadSnapshot(tx, conversationId, schemas);
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
        const snap = await loadSnapshot(tx, conversationId, schemas);
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
        const snap = await loadSnapshot(tx, conversationId, schemas);
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
