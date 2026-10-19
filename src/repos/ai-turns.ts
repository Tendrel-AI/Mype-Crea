/** Durable, tenant/user-scoped AI turn and asynchronous event repositories. */
import { createHash, randomUUID } from 'node:crypto';

import type { ConversationId, TaskId, UUID } from '../core/contracts';

import { withTenantAdminTransaction, withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';

import type { AiTurnAttempt, DeliverableKind, MessageRow, UsageSummary } from './models';

import type { A2AArtifact } from '../core/agent-types';

import type { AiEventKind, AiTurnEvent, AiTurnNotice, AiTurnRow, AiTurnStage } from './models';

import type { JsonValue, Purpose, ProviderId } from '../services/ai-config/manifest';

import type { AiConfigManifestV1 } from '../services/ai-config/manifest';

import type { RepositoryActor } from './ai-config';
import { summarizeUsage } from './usage-summary';

interface TurnDbRow {
  readonly id: UUID;
  readonly userId: UUID;
  readonly conversationId: ConversationId;
  readonly requestId: UUID;
  readonly inputHash: string;
  readonly inputContent: string | null;
  readonly responseContent: string | null;
  readonly releaseId: UUID;
  readonly stage: AiTurnStage;
  readonly version: number;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly failureCategory: string | null;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}
interface ClaimDbRow extends TurnDbRow {
  readonly leaseActive: boolean;
}
interface OwnerDbRow {
  readonly conversation_id: ConversationId;
  readonly user_id: UUID;
  readonly release_id: UUID;
  readonly input_content: string | null;
}
interface MessageDbRow extends Omit<MessageRow, 'createdAt' | 'completedAt'> {
  readonly createdAt: string | Date;
  readonly completedAt: string | Date | null;
}
interface NoticeDbRow extends Omit<AiTurnNotice, 'createdAt'> {
  readonly createdAt: string | Date;
}
interface AttemptDbRow extends Omit<AiTurnAttempt, 'costAmount' | 'startedAt' | 'finishedAt'> {
  readonly costAmount: string | number | null;
  readonly startedAt: string | Date;
  readonly finishedAt: string | Date | null;
}
interface ReconcileRow {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly agentId: string;
  readonly status: 'completed' | 'failed';
  readonly errorCategory: string | null;
  readonly userId: UUID;
  readonly deliverableIds: readonly UUID[];
  readonly artifacts: JsonValue;
}
const TURN_COLUMNS = `id, user_id AS "userId", conversation_id AS "conversationId", request_id AS "requestId", input_hash AS "inputHash", input_content AS "inputContent", response_content AS "responseContent", release_id AS "releaseId", stage, version, payload, failure_category AS "failureCategory", created_at AS "createdAt", updated_at AS "updatedAt"`;

function mapTurn(row: TurnDbRow): AiTurnRow {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    requestId: row.requestId,
    inputHash: row.inputHash,
    inputContent: row.inputContent,
    responseContent: row.responseContent,
    releaseId: row.releaseId,
    stage: row.stage,
    version: row.version,
    payload: row.payload,
    failureCategory: row.failureCategory,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
function hash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
function json(value: unknown): string {
  return JSON.stringify(value);
}
function mapAttempt(row: AttemptDbRow): AiTurnAttempt {
  return {
    ...row,
    costAmount: row.costAmount === null ? null : Number(row.costAmount),
    startedAt: new Date(row.startedAt).toISOString(),
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
  };
}
function mapMessage(row: MessageDbRow): MessageRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
  };
}
function mapNotice(row: NoticeDbRow): AiTurnNotice {
  return { ...row, createdAt: new Date(row.createdAt).toISOString() };
}
async function queryUsage(tx: TxClient, tenantId: UUID, input: {
  userId?: UUID;
  from?: string;
  to?: string
}): Promise<UsageSummary> {
  const result = await tx.query<{
    attempts: number;

    input_tokens: number | null;

    output_tokens: number | null;

    unknown_input: number;

    unknown_output: number;

    known_cost: string;

    unknown_cost_attempts: number;

  }>(
    `SELECT count(*)::int attempts,
        sum(input_tokens)::int input_tokens,
        sum(output_tokens)::int output_tokens,
        count(*) FILTER(WHERE input_tokens IS NULL)::int unknown_input,
        count(*) FILTER(WHERE output_tokens IS NULL)::int unknown_output,
        coalesce(sum(cost_amount),0)::text known_cost,
        count(*) FILTER(WHERE cost_amount IS NULL)::int unknown_cost_attempts
        FROM ai_turn_attempts
        WHERE tenant_id=$1
          AND ($2::uuid IS NULL OR user_id=$2)
          AND ($3::timestamptz IS NULL OR started_at >= $3)
          AND ($4::timestamptz IS NULL OR started_at < $4)`,
    [tenantId, input.userId ?? null, input.from ?? null, input.to ?? null],
  );

  const row = result.rows[0];
  return summarizeUsage({
    attempts: row.attempts,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    unknownInputAttempts: row.unknown_input,
    unknownOutputAttempts: row.unknown_output,
    knownCost: row.known_cost,
    unknownCostAttempts: row.unknown_cost_attempts,
  });

}
async function deleteTurnContent(tx: TxClient, turnId: UUID): Promise<boolean> {
  const result = await tx.query<{ scrubbed: boolean }>(
    `SELECT app.scrub_ai_turn_trace($1) AS scrubbed`,
    [turnId],
  );

  return result.rows[0]?.scrubbed === true;

}

export type ClaimTurnResult =
  | {
    readonly kind: 'acquired';
    readonly turn: AiTurnRow;
    readonly ownerToken: UUID
  }
  | {
    readonly kind: 'completed' | 'in_progress' | 'uncertain';
    readonly turn: AiTurnRow
  }
  | { readonly kind: 'conflict' };

export interface CheckpointInput {
  turnId: UUID;
  ownerToken: UUID;
  expectedVersion: number;
  stage: AiTurnStage;
  payload: Record<string, JsonValue>
}
export interface StartAttemptInput {
  turnId: UUID;
  ownerToken: UUID;
  purpose: Purpose;
  primaryProfileId: string;
  effectiveProfileId: string;

  provider: ProviderId;
  model: string;
  modelRevision?: string | null;
  requestContent?: string | null;

}

export function aiTurnsRepo(tenant: Tenant, user: User, actor?: RepositoryActor) {
  async function requireTenantAdmin(tx: TxClient): Promise<void> {
    if (actor?.tenantRole !== 'admin') throw new Error('No tienes permisos para consultar los registros de esta organización.');

    const result = await tx.query(
      `SELECT 1
        FROM users
        WHERE tenant_id=$1 AND id=$2 AND status='active' AND role='admin'`,
      [tenant.id, user.id],
    );

    if (!result.rows.length) throw new Error('No tienes permisos para consultar los registros de esta organización.');

  }
  async function getTurnIn(tx: TxClient, turnId: UUID): Promise<AiTurnRow | undefined> {
    const result = await tx.query<TurnDbRow>(`SELECT ${TURN_COLUMNS}
        FROM ai_turns
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenant.id, user.id, turnId]);

    return result.rows[0] ? mapTurn(result.rows[0]) : undefined;

  }
  async function owner(tx: TxClient, turnId: UUID, token: UUID): Promise<OwnerDbRow> {
    const result = await tx.query<OwnerDbRow>(`SELECT conversation_id,
        user_id,
        release_id,
        input_content
        FROM ai_turns
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND owner_token=$4 FOR UPDATE`, [tenant.id, user.id, turnId, token]);

    if (!result.rows[0]) throw new Error('El turno ya no está disponible.');

    return result.rows[0];

  }
  async function requireActiveMember(tx: TxClient): Promise<void> {
    const result = await tx.query(`SELECT 1
        FROM users
        WHERE tenant_id=$1 AND id=$2 AND status='active'`, [tenant.id, user.id]);

    if (result.rows.length === 0) throw new Error('Tu cuenta ya no tiene acceso activo a esta organización.');

  }
  return {
    async claimTurn(input: {
      conversationId: ConversationId;
      requestId: UUID;
      inputContent: string
    }): Promise<ClaimTurnResult> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const inputHash = hash(input.inputContent);

        const prior = await tx.query<ClaimDbRow>(`SELECT ${TURN_COLUMNS},
        lease_expires_at>now() AS "leaseActive"
        FROM ai_turns
        WHERE tenant_id=$1 AND user_id=$2 AND conversation_id=$3 AND request_id=$4 FOR UPDATE`, [tenant.id, user.id, input.conversationId, input.requestId]);

        if (prior.rows[0]) {
          const row = prior.rows[0];
          const turn = mapTurn(row);

          if (row.inputHash !== inputHash || (row.inputContent !== null && row.inputContent !== input.inputContent)) return { kind: 'conflict' };

          if (row.stage === 'responded') return { kind: 'completed', turn };

          if (row.stage === 'uncertain') return { kind: 'uncertain', turn };

          if (row.leaseActive) return { kind: 'in_progress', turn };

          const active = await tx.query(`SELECT 1
        FROM ai_turn_attempts
        WHERE tenant_id=$1 AND turn_id=$2 AND (status IN ('started','uncertain') OR (status='succeeded' AND $3='reserved'))
        LIMIT 1`, [tenant.id, row.id, row.stage]);

          if (row.stage === 'effects_started' || active.rows.length) {
            await tx.query(`UPDATE ai_turns
        SET stage='uncertain',
        failure_category='ambiguous_external_outcome',
        version=version+1,
        owner_token=NULL,
        lease_expires_at=NULL,
        updated_at=now()
        WHERE tenant_id=$1 AND id=$2`, [tenant.id, row.id]);

            const updated = await getTurnIn(tx, row.id);
            return { kind: 'uncertain', turn: updated! };

          }
          if (!['reserved', 'extracted', 'effects_committed'].includes(row.stage)) return { kind: 'in_progress', turn };

          const token = randomUUID();

          const updated = await tx.query<TurnDbRow>(`UPDATE ai_turns
        SET owner_token=$3,
        lease_expires_at=now()+interval '120 seconds',
        version=version+1,
        updated_at=now()
          WHERE tenant_id=$1 AND id=$2
        RETURNING ${TURN_COLUMNS}`, [tenant.id, row.id, token]);

          return { kind: 'acquired', turn: mapTurn(updated.rows[0]), ownerToken: token };

        }
        const pin = await tx.query<{ ai_release_id: UUID | null }>(`SELECT ai_release_id
        FROM conversations
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND configuration_state='pinned'`, [tenant.id, user.id, input.conversationId]);

        if (!pin.rows[0]?.ai_release_id) throw new Error('La conversación no tiene una configuración activa.');

        const token = randomUUID();

        const inserted = await tx.query<TurnDbRow>(`INSERT INTO ai_turns(tenant_id,
        user_id,
        conversation_id,
        release_id,
        request_id,
        input_hash,
        input_content,
        stage,
        owner_token,
        lease_expires_at)
        VALUES($1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,'reserved',
        $8,
        now()+interval '120 seconds')
        ON CONFLICT (tenant_id, conversation_id, request_id) DO NOTHING
        RETURNING ${TURN_COLUMNS}`, [tenant.id, user.id, input.conversationId, pin.rows[0].ai_release_id, input.requestId, inputHash, input.inputContent, token]);

        if (inserted.rows[0]) return { kind: 'acquired', turn: mapTurn(inserted.rows[0]), ownerToken: token };

        const retry = await tx.query<ClaimDbRow>(`SELECT ${TURN_COLUMNS},
        lease_expires_at>now() AS "leaseActive"
        FROM ai_turns
        WHERE tenant_id=$1 AND user_id=$2 AND conversation_id=$3 AND request_id=$4`, [tenant.id, user.id, input.conversationId, input.requestId]);

        if (retry.rows[0]) {
          const row = retry.rows[0];

          if (row.inputHash !== inputHash || (row.inputContent !== null && row.inputContent !== input.inputContent)) return { kind: 'conflict' };

          return { kind: 'in_progress', turn: mapTurn(row) };

        }
        const activeTurn = await tx.query<TurnDbRow>(`SELECT ${TURN_COLUMNS}
        FROM ai_turns
        WHERE tenant_id=$1 AND user_id=$2 AND conversation_id=$3 AND stage<>'responded'`, [tenant.id, user.id, input.conversationId]);

        return activeTurn.rows[0] ? { kind: 'in_progress', turn: mapTurn(activeTurn.rows[0]) } : { kind: 'conflict' };

      });

    },
    async checkpointTurn(input: CheckpointInput): Promise<AiTurnRow> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await owner(tx, input.turnId, input.ownerToken);
        const result = await tx.query<TurnDbRow>(`UPDATE ai_turns
        SET stage=$5,
        payload=$6::jsonb,
        version=version+1,
        lease_expires_at=now()+interval '120 seconds',
        updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND owner_token=$4 AND version=$7
        RETURNING ${TURN_COLUMNS}`, [tenant.id, user.id, input.turnId, input.ownerToken, input.stage, json(input.payload), input.expectedVersion]);
        if (!result.rows[0]) throw new Error('El turno cambió y debe recuperarse antes de continuar.');
        return mapTurn(result.rows[0]);
      });

    },
    async ensureUserMessage(input: {
      turnId: UUID;
      ownerToken: UUID;
      conversationId: ConversationId;
      content: string
    }): Promise<MessageRow> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const turn = await owner(tx, input.turnId, input.ownerToken);
        if (turn.conversation_id !== input.conversationId || turn.input_content !== input.content) throw new Error('El mensaje no coincide con el turno.');
        const r = await tx.query<MessageDbRow>(`INSERT INTO messages(tenant_id,
        conversation_id,
        user_id,
        role,
        content,
        generation_status,
        ai_turn_id)
        VALUES($1,
        $2,
        $3,'user',
        $4,'complete',
        $5)
        ON CONFLICT (tenant_id, ai_turn_id, role) WHERE ai_turn_id IS NOT NULL DO UPDATE
        SET content=EXCLUDED.content
        RETURNING id,
        conversation_id AS "conversationId",
        user_id AS "userId",
        role,
        content,
        generation_status AS "generationStatus",
        completed_at AS "completedAt",
        created_at AS "createdAt"`, [tenant.id, input.conversationId, user.id, input.content, input.turnId]);
        const row = r.rows[0];
        return mapMessage(row);
      });
    },
    async renewTurnLease(input: {
      turnId: UUID;
      ownerToken: UUID
    }): Promise<boolean> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const r = await tx.query(`UPDATE ai_turns
        SET lease_expires_at=now()+interval '120 seconds',
        updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND owner_token=$4 AND stage NOT IN ('responded','uncertain')`, [tenant.id, user.id, input.turnId, input.ownerToken]);
        return r.rowCount === 1;
      });
    },
    async startAttempt(input: StartAttemptInput): Promise<UUID> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await requireActiveMember(tx);

        const turn = await owner(tx, input.turnId, input.ownerToken);

        const release = await tx.query<{ manifest: AiConfigManifestV1 }>(
          `SELECT manifest
        FROM ai_releases
        WHERE tenant_id=$1 AND id=$2 AND status IN ('frozen','retired')`,
          [tenant.id, turn.release_id],
        );

        const fallback = release.rows[0]?.manifest.fallback[input.purpose];

        if (!fallback || input.primaryProfileId !== fallback.primaryProfileId) {
          throw new Error('El perfil del intento no coincide con la versión fijada.');

        }
        const next = await tx.query<{ n: number }>(
          `SELECT COALESCE(max(attempt_number),0)+1 AS n
        FROM ai_turn_attempts
        WHERE tenant_id=$1 AND turn_id=$2 AND purpose=$3`,
          [tenant.id, input.turnId, input.purpose],
        );

        const attemptNumber = next.rows[0].n;

        const attemptLimit = Math.min(2, fallback.maxAttempts);

        const profiles = [fallback.primaryProfileId, ...fallback.fallbackProfileIds];

        if (attemptNumber > attemptLimit || input.effectiveProfileId !== profiles[attemptNumber - 1]) {
          throw new Error('El intento excede la secuencia de respaldo configurada.');

        }
        const result = await tx.query<{ id: UUID }>(
          `INSERT INTO ai_turn_attempts
(tenant_id,
        user_id,
        conversation_id,
        turn_id,
        release_id,
        purpose,
        attempt_number,
        primary_profile_id,
        effective_profile_id,
        provider,
        model,
        model_revision,
        status)
        VALUES($1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,'started')
        RETURNING id`,
          [tenant.id, user.id, turn.conversation_id, input.turnId, turn.release_id, input.purpose,
            attemptNumber, input.primaryProfileId, input.effectiveProfileId, input.provider,
          input.model, input.modelRevision ?? null],
        );

        return result.rows[0].id;

      });

    },
    async attachAttemptRequest(input: {
      attemptId: UUID;
      turnId: UUID;
      ownerToken: UUID;
      requestContent: string
    }): Promise<void> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await owner(tx, input.turnId, input.ownerToken);
        const r = await tx.query(`UPDATE ai_turn_attempts
        SET request_content=$5
        WHERE tenant_id=$1 AND user_id=$2 AND turn_id=$3 AND id=$4 AND status='started'`, [tenant.id, user.id, input.turnId, input.attemptId, input.requestContent]);
        if (r.rowCount !== 1) throw new Error('El intento ya no está disponible.');
      });
    },
    async finishAttempt(input: {
      attemptId: UUID;
      turnId: UUID;
      ownerToken: UUID;
      outcome: 'succeeded' | 'failed' | 'uncertain';
      responseContent?: string | null;
      failureCategory?: string | null;
      providerStatus?: number | null;
      usage?: {
        promptTokens?: number | null;
        completionTokens?: number | null;
        totalTokens?: number | null;
        cacheReadTokens?: number | null;
        reasoningTokens?: number | null;
        latencyMs?: number | null
      };
      cost?: null | {
        amount: number | null;
        currency: string | null;
        source: 'provider_reported' | 'estimated' | null;
        pricingVersion?: string | null
      }
    }): Promise<void> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await owner(tx, input.turnId, input.ownerToken);
        const c = await tx.query(`UPDATE ai_turn_attempts
        SET status=$5,
        response_content=$6,
        failure_category=$7,
        input_tokens=$8,
        output_tokens=$9,
        latency_ms=$10,
        cost_amount=$11,
        cost_currency=$12,
        cost_source=$13,
        pricing_version=$14,
        provider_status=$15,
        total_tokens=$16,
        cache_read_tokens=$17,
        reasoning_tokens=$18,
        finished_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND turn_id=$3 AND id=$4 AND status='started'`, [tenant.id, user.id, input.turnId, input.attemptId, input.outcome, input.responseContent ?? null, input.failureCategory ?? null, input.usage?.promptTokens ?? null, input.usage?.completionTokens ?? null, input.usage?.latencyMs ?? null, input.cost?.amount ?? null, input.cost?.currency ?? null, input.cost?.source ?? null, input.cost?.pricingVersion ?? null, input.providerStatus ?? null, input.usage?.totalTokens ?? null, input.usage?.cacheReadTokens ?? null, input.usage?.reasoningTokens ?? null]);
        if (c.rowCount !== 1) throw new Error('El intento ya no está disponible.');
      });
    },
    async recordNotice(input: {
      turnId: UUID;
      ownerToken: UUID;
      code: string;
      content?: string | null
    }): Promise<AiTurnNotice> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await owner(tx, input.turnId, input.ownerToken);
        const r = await tx.query<NoticeDbRow>(`INSERT INTO ai_turn_notices(tenant_id,
        user_id,
        conversation_id,
        turn_id,
        code,
        content) SELECT tenant_id,
        user_id,
        conversation_id,
        id,
        $4,
        $5
        FROM ai_turns
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3
        RETURNING id,
        turn_id AS "turnId",
        conversation_id AS "conversationId",
        code,
        content,
        created_at AS "createdAt"`, [tenant.id, user.id, input.turnId, input.code, input.content ?? null]);
        return mapNotice(r.rows[0]);
      });
    },
    async completeTurn(input: {
      turnId: UUID;
      ownerToken: UUID;
      responseContent: string
    }): Promise<{
      turn: AiTurnRow;
      notices: AiTurnNotice[]
    }> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const row = await owner(tx, input.turnId, input.ownerToken);
        const r = await tx.query<TurnDbRow>(`UPDATE ai_turns
        SET stage='responded',
        response_content=$5,
        completed_at=now(),
        lease_expires_at=NULL,
        version=version+1,
        updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND owner_token=$4
        RETURNING ${TURN_COLUMNS}`, [tenant.id, user.id, input.turnId, input.ownerToken, input.responseContent]);
        if (!r.rows[0]) throw new Error('El turno ya no está disponible.');
        await tx.query(`INSERT INTO messages(tenant_id,
        conversation_id,
        user_id,
        role,
        content,
        generation_status,
        ai_turn_id)
        VALUES($1,
        $2,
        $3,'assistant',
        $4,'complete',
        $5)
        ON CONFLICT (tenant_id, ai_turn_id, role) WHERE ai_turn_id IS NOT NULL DO UPDATE
        SET content=EXCLUDED.content`, [tenant.id, row.conversation_id, user.id, input.responseContent, input.turnId]);
        const n = await tx.query<NoticeDbRow>(`SELECT id,
        turn_id AS "turnId",
        conversation_id AS "conversationId",
        code,
        content,
        created_at AS "createdAt"
        FROM ai_turn_notices
        WHERE tenant_id=$1 AND user_id=$2 AND turn_id=$3
        ORDER BY created_at, id`, [tenant.id, user.id, input.turnId]);
        return { turn: mapTurn(r.rows[0]), notices: n.rows.map(mapNotice) };
      });
    },
    async failTurn(input: {
      turnId: UUID;
      ownerToken: UUID;
      category: string;
      stage?: AiTurnStage;
      uncertain?: boolean
    }): Promise<AiTurnRow> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await owner(tx, input.turnId, input.ownerToken);
        const stage = input.uncertain ? 'uncertain' : (input.stage ?? 'reserved');
        if (!['reserved', 'extracted', 'effects_committed', 'uncertain'].includes(stage)) throw new Error('No se puede reintentar desde esta etapa.');
        const r = await tx.query<TurnDbRow>(`UPDATE ai_turns
        SET stage=$5,
        failure_category=$6,
        owner_token=NULL,
        lease_expires_at=NULL,
        version=version+1,
        updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND owner_token=$4
        RETURNING ${TURN_COLUMNS}`, [tenant.id, user.id, input.turnId, input.ownerToken, stage, input.category]);
        return mapTurn(r.rows[0]);
      });
    },
    async getTurn(turnId: UUID): Promise<AiTurnRow | undefined> {
      return withTenantTransaction(tenant, user, tx => getTurnIn(tx, turnId));
    },
    async listTurns(conversationId: ConversationId): Promise<AiTurnRow[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const r = await tx.query<TurnDbRow>(`SELECT ${TURN_COLUMNS}
        FROM ai_turns
        WHERE tenant_id=$1 AND user_id=$2 AND conversation_id=$3
        ORDER BY created_at DESC, id`, [tenant.id, user.id, conversationId]);
        return r.rows.map(mapTurn);
      });
    },
    async adminGetTurn(turnId: UUID): Promise<AiTurnRow | undefined> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await requireTenantAdmin(tx);

        const result = await tx.query<TurnDbRow>(
          `SELECT ${TURN_COLUMNS}
        FROM ai_turns
        WHERE tenant_id=$1 AND id=$2`,
          [tenant.id, turnId],
        );

        return result.rows[0] ? mapTurn(result.rows[0]) : undefined;

      });

    },
    async adminListTurns(input: {
      conversationId?: ConversationId;
      limit?: number
    } = {}): Promise<AiTurnRow[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await requireTenantAdmin(tx);

        const result = await tx.query<TurnDbRow>(
          `SELECT ${TURN_COLUMNS}
        FROM ai_turns
        WHERE tenant_id=$1 AND ($2::uuid IS NULL OR conversation_id=$2)
        ORDER BY created_at DESC, id
        LIMIT $3`,
          [tenant.id, input.conversationId ?? null, Math.min(Math.max(input.limit ?? 100, 1), 500)],
        );

        return result.rows.map(mapTurn);

      });

    },
    async adminListAttempts(turnId: UUID): Promise<AiTurnAttempt[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await requireTenantAdmin(tx);

        const result = await tx.query<AttemptDbRow>(
          `SELECT id,
        turn_id AS "turnId",
        purpose,
        attempt_number AS "attemptNumber",
        primary_profile_id AS "primaryProfileId",
        effective_profile_id AS "effectiveProfileId",
        provider,
        model,
        model_revision AS "modelRevision",
        status,
        failure_category AS "failureCategory",
        provider_status AS "providerStatus",
        request_content AS "requestContent",
        response_content AS "responseContent",
        input_tokens AS "inputTokens",
        output_tokens AS "outputTokens",
        latency_ms AS "latencyMs",
        cost_amount AS "costAmount",
        cost_currency AS "costCurrency",
        cost_source AS "costSource",
        pricing_version AS "pricingVersion",
        started_at AS "startedAt",
        finished_at AS "finishedAt"
        FROM ai_turn_attempts
        WHERE tenant_id=$1 AND turn_id=$2
        ORDER BY purpose, attempt_number`,
          [tenant.id, turnId],
        );

        return result.rows.map(mapAttempt);

      });

    },
    async adminListNotices(turnId: UUID): Promise<AiTurnNotice[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await requireTenantAdmin(tx);

        const result = await tx.query<NoticeDbRow>(
          `SELECT id,
        turn_id AS "turnId",
        conversation_id AS "conversationId",
        code,
        content,
        created_at AS "createdAt"
        FROM ai_turn_notices
        WHERE tenant_id=$1 AND turn_id=$2
        ORDER BY created_at, id`,
          [tenant.id, turnId],
        );

        return result.rows.map(mapNotice);

      });

    },
    async adminGetUsage(input: {
      from?: string;
      to?: string
    } = {}): Promise<UsageSummary> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await requireTenantAdmin(tx);

        return queryUsage(tx, tenant.id, input);

      });

    },
    async adminDeleteTraceContent(turnId: UUID): Promise<boolean> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await requireTenantAdmin(tx);

        return deleteTurnContent(tx, turnId);

      });

    },
    async listAttempts(input: {
      turnId: UUID;
      purpose?: Purpose
    }): Promise<AiTurnAttempt[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const r = await tx.query<AttemptDbRow>(`SELECT id,
        turn_id AS "turnId",
        purpose,
        attempt_number AS "attemptNumber",
        primary_profile_id AS "primaryProfileId",
        effective_profile_id AS "effectiveProfileId",
        provider,
        model,
        model_revision AS "modelRevision",
        status,
        failure_category AS "failureCategory",
        provider_status AS "providerStatus",
        request_content AS "requestContent",
        response_content AS "responseContent",
        input_tokens AS "inputTokens",
        output_tokens AS "outputTokens",
        latency_ms AS "latencyMs",
        cost_amount AS "costAmount",
        cost_currency AS "costCurrency",
        cost_source AS "costSource",
        pricing_version AS "pricingVersion",
        started_at AS "startedAt",
        finished_at AS "finishedAt"
        FROM ai_turn_attempts
        WHERE tenant_id=$1 AND user_id=$2 AND turn_id=$3 AND ($4::text IS NULL OR purpose=$4)
        ORDER BY purpose, attempt_number`, [tenant.id, user.id, input.turnId, input.purpose ?? null]);
        return r.rows.map(mapAttempt);
      });
    },
    async listNotices(turnId: UUID): Promise<AiTurnNotice[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const r = await tx.query<NoticeDbRow>(`SELECT id,
        turn_id AS "turnId",
        conversation_id AS "conversationId",
        code,
        content,
        created_at AS "createdAt"
        FROM ai_turn_notices
        WHERE tenant_id=$1 AND user_id=$2 AND turn_id=$3
        ORDER BY created_at, id`, [tenant.id, user.id, turnId]);
        return r.rows.map(mapNotice);
      });
    },
    async getUsage(input: {
      from?: string;
      to?: string
    } = {}): Promise<UsageSummary> {
      return withTenantTransaction(tenant, user, async (tx) => {
        return queryUsage(tx, tenant.id, { ...input, userId: user.id });
      });

    },
    async deleteTraceContent(turnId: UUID): Promise<boolean> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await requireTenantAdmin(tx);

        return deleteTurnContent(tx, turnId);

      });

    },
    async peekEvents(input: {
      conversationId: ConversationId;
      afterEventId?: string;
      limit?: number
    }): Promise<AiTurnEvent[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const r = await tx.query<AiTurnEvent>(`SELECT id,
        event_id AS "eventId",
        conversation_id AS "conversationId",
        turn_id AS "turnId",
        task_id AS "taskId",
        kind,
        payload,
        created_at AS "createdAt",
        acknowledged_at AS "acknowledgedAt"
        FROM ai_turn_events
        WHERE tenant_id=$1 AND user_id=$2 AND conversation_id=$3 AND acknowledged_at IS NULL AND ($4::text IS NULL OR event_id>$4)
        ORDER BY created_at, id
        LIMIT $5`, [tenant.id, user.id, input.conversationId, input.afterEventId ?? null, Math.min(Math.max(input.limit ?? 50, 1), 200)]);
        return r.rows;
      });
    },
    async ackEvent(input: { eventId: string }): Promise<boolean> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const r = await tx.query(`UPDATE ai_turn_events
        SET acknowledged_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND event_id=$3 AND acknowledged_at IS NULL`, [tenant.id, user.id, input.eventId]);
        return r.rowCount === 1;
      });
    },
    async settleTaskAndEnqueue(input: {
      conversationId: ConversationId;

      taskId: TaskId;

      state: 'completed' | 'failed';

      deliverableKind: DeliverableKind;

      artifacts: ReadonlyArray<A2AArtifact>;

      errorCategory?: string;

    }): Promise<{ deliverableIds: UUID[] }> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const task = await tx.query<{
          agent_id: string;
          status: string
        }>(
          `SELECT t.agent_id,
        t.status
        FROM agent_tasks t
        JOIN conversations c ON c.tenant_id = t.tenant_id AND c.id = t.conversation_id
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.conversation_id = $3 AND c.user_id = $4
        FOR UPDATE OF t, c`,
          [tenant.id, input.taskId, input.conversationId, user.id],
        );

        if (!task.rows[0]) throw new Error('La tarea ya no está disponible.');

        const priorStatus = task.rows[0].status;

        if (['completed', 'failed'].includes(priorStatus) && priorStatus !== input.state) {
          throw new Error('La tarea ya tiene un resultado guardado.');

        }
        const ids: UUID[] = [];

        if (priorStatus === 'completed' || priorStatus === 'failed') {
          const existing = await tx.query<{ id: UUID }>(
            `SELECT id
        FROM deliverables
        WHERE tenant_id=$1 AND conversation_id=$2 AND agent_task_id=$3
        ORDER BY created_at, id`,
            [tenant.id, input.conversationId, input.taskId],
          );

          ids.push(...existing.rows.map((row) => row.id));

        } else if (input.state === 'completed') {
          for (const artifact of input.artifacts) {
            if (!artifact.url && artifact.inline === undefined) continue;

            const inserted = await tx.query<{ id: UUID }>(
              `INSERT INTO deliverables
(tenant_id,
        conversation_id,
        agent_task_id,
        user_id,
        kind,
        content_url,
        content_inline)
        VALUES ($1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb)
        RETURNING id`,
              [tenant.id, input.conversationId, input.taskId, user.id, input.deliverableKind, artifact.url ?? null,
              artifact.url ? null : JSON.stringify({ value: artifact.inline, kind: artifact.kind, metadata: artifact.metadata ?? {} })],
            );

            ids.push(inserted.rows[0].id);

          }
        }
        if (!['completed', 'failed'].includes(priorStatus)) {
          await tx.query(
            `UPDATE agent_tasks
        SET status=$4,
        completed_at=now(),
        error_category=$5
        WHERE tenant_id=$1 AND id=$2 AND conversation_id=$3`,
            [tenant.id, input.taskId, input.conversationId, input.state, input.state === 'failed' ? (input.errorCategory ?? 'permanent_bug') : null],
          );

          await tx.query(
            `UPDATE conversations
        SET agent_states=jsonb_set(agent_states,
        ARRAY[$4],(agent_states->$4)-'lastDispatchedTaskId',
        false)
        WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND agent_states->$4->>'lastDispatchedTaskId'=$5`,
            [tenant.id, input.conversationId, user.id, task.rows[0].agent_id, input.taskId],
          );

        }
        const kind = input.state === 'completed' ? 'artifact' : 'notice';

        const eventId = `${input.taskId}:announce_${input.state === 'completed' ? 'completion' : 'failure'}`;

        const artifacts = input.state === 'completed'
          ? input.artifacts.map((artifact) => ({
            kind: artifact.kind,
            url: artifact.url ?? null,
            inline: artifact.inline === undefined ? null : artifact.inline as JsonValue,
            metadata: artifact.metadata ? artifact.metadata as Record<string, JsonValue> : {},
          }))
          : [];

        const payload: Record<string, JsonValue> = {
          type: `agent_${input.state}`,
          taskId: input.taskId,
          agentId: task.rows[0].agent_id,
          deliverableIds: ids,
          artifacts,
        };

        if (input.errorCategory) payload.errorCategory = input.errorCategory;

        await tx.query(
          `INSERT INTO ai_turn_events(tenant_id,
        user_id,
        conversation_id,
        task_id,
        event_id,
        kind,
        payload)
        VALUES($1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb)
        ON CONFLICT (tenant_id, event_id) DO NOTHING`,
          [tenant.id, user.id, input.conversationId, input.taskId, eventId, kind, json(payload)],
        );

        return { deliverableIds: ids };

      });

    },
    async enqueueSettledTaskEvents(input: {
      conversationId: ConversationId;
      taskId: TaskId
    }): Promise<void> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const task = await tx.query<{
          status: string;
          error_category: string | null
        }>(`SELECT t.status,
        t.error_category
        FROM agent_tasks t
        JOIN conversations c ON c.tenant_id=t.tenant_id AND c.id=t.conversation_id
        WHERE t.tenant_id=$1 AND t.id=$2 AND t.conversation_id=$3 AND c.user_id=$4`, [tenant.id, input.taskId, input.conversationId, user.id]);
        const status = task.rows[0]?.status;
        if (!status || !['completed', 'failed'].includes(status)) return;
        const ds = await tx.query<{ id: UUID }>(`SELECT id
        FROM deliverables
        WHERE tenant_id=$1 AND conversation_id=$2 AND agent_task_id=$3
        ORDER BY created_at, id`, [tenant.id, input.conversationId, input.taskId]);
        const state = status as 'completed' | 'failed';
        const eventId = `${input.taskId}:announce_${state === 'completed' ? 'completion' : 'failure'}`;
        const payload: Record<string, JsonValue> = { type: `agent_${state}`, taskId: input.taskId, deliverableIds: ds.rows.map(row => row.id) };
        if (task.rows[0].error_category) payload.errorCategory = task.rows[0].error_category;
        await tx.query(`INSERT INTO ai_turn_events(tenant_id,
        user_id,
        conversation_id,
        task_id,
        event_id,
        kind,
        payload)
        VALUES($1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb)
        ON CONFLICT (tenant_id, event_id) DO NOTHING`, [tenant.id, user.id, input.conversationId, input.taskId, eventId, state === 'completed' ? 'artifact' : 'notice', json(payload)]);
      });
    },
    async listSettledTasksMissingEvents(input: { limit?: number } = {}): Promise<Array<{
      conversationId: ConversationId;
      taskId: TaskId
    }>> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const r = await tx.query<{
          conversation_id: ConversationId;
          task_id: TaskId
        }>(`SELECT t.conversation_id,
        t.id AS task_id
        FROM agent_tasks t
        JOIN conversations c ON c.tenant_id=t.tenant_id AND c.id=t.conversation_id
        LEFT JOIN ai_turn_events e ON e.tenant_id=t.tenant_id AND e.event_id=t.id::text||CASE WHEN t.status='completed' THEN ':announce_completion' ELSE ':announce_failure' END
        WHERE t.tenant_id=$1 AND c.user_id=$2 AND t.status IN ('completed','failed') AND e.id IS NULL
        ORDER BY t.completed_at, t.id
        LIMIT $3`, [tenant.id, user.id, Math.min(Math.max(input.limit ?? 100, 1), 500)]);
        return r.rows.map(row => ({ conversationId: row.conversation_id, taskId: row.task_id }));
      });
    },
  };

}

export function aiEventsRepo(tenant: Tenant) {
  return {
    async reconcileSettledTasks(input: { limit?: number } = {}): Promise<number> {
      return withTenantAdminTransaction(tenant, async (tx) => {
        const rows = await tx.query<ReconcileRow>(
          `SELECT t.id AS "taskId",
        t.conversation_id AS "conversationId",
        t.agent_id AS "agentId",
        t.status,
        t.error_category AS "errorCategory",
        c.user_id AS "userId",
        COALESCE(jsonb_agg(d.id) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS "deliverableIds",
        COALESCE(jsonb_agg(jsonb_build_object('kind',
        COALESCE(d.content_inline->>'kind',
        d.kind),'url',
        d.content_url,'inline',
        d.content_inline->'value')) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS artifacts
        FROM agent_tasks t
        JOIN conversations c ON c.tenant_id=t.tenant_id AND c.id=t.conversation_id
        LEFT JOIN deliverables d ON d.tenant_id=t.tenant_id AND d.agent_task_id=t.id
        WHERE t.tenant_id=$1 AND t.status IN ('completed','failed')
        GROUP BY t.id, c.user_id
        ORDER BY t.completed_at, t.id
        LIMIT $2`,
          [tenant.id, Math.min(Math.max(input.limit ?? 100, 1), 500)],
        );

        let inserted = 0;

        for (const row of rows.rows) {
          await tx.query(`SELECT set_config('app.user_id',
        $1,
        true)`, [row.userId]);

          const state = row.status as 'completed' | 'failed';

          const eventId = `${row.taskId}:announce_${state === 'completed' ? 'completion' : 'failure'}`;

          const prior = await tx.query(`SELECT 1
        FROM ai_turn_events
        WHERE tenant_id=$1 AND user_id=$2 AND event_id=$3`, [tenant.id, row.userId, eventId]);

          if (prior.rows.length) continue;

          const payload: Record<string, JsonValue> = {
            type: `agent_${state}`,
            taskId: row.taskId as string,
            agentId: row.agentId as string,
            deliverableIds: row.deliverableIds as JsonValue,
            artifacts: row.artifacts as JsonValue,
          };

          if (row.errorCategory) payload.errorCategory = row.errorCategory as string;

          await tx.query(
            `INSERT INTO ai_turn_events(tenant_id,
        user_id,
        conversation_id,
        task_id,
        event_id,
        kind,
        payload)
        VALUES($1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb)
        ON CONFLICT (tenant_id, event_id) DO NOTHING`,
            [tenant.id, row.userId, row.conversationId, row.taskId, eventId, state === 'completed' ? 'artifact' : 'notice', json(payload)],
          );

          inserted += 1;

        }
        return inserted;

      });

    },
  };

}
export type AiTurnsRepo = ReturnType<typeof aiTurnsRepo>;

export type AiEventsRepo = ReturnType<typeof aiEventsRepo>;

