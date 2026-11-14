/**
 * KAN-44 rejected-write log (`write_rejections`). Append-only: `record` inserts, `list` reads
 * the caller's own rows (an active tenant admin reads the tenant's, by RLS). The id and
 * `created_at` come from the database; the payload arrives already hashed and the column's
 * CHECK refuses anything that is not a SHA-256 hex. All access goes through
 * `withTenantTransaction(tenant, user)` as app_user.
 */
import type { UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import type { WriteChannel, WriteRejectionRow } from './models';

export interface WriteRejectionInput {
  readonly channel: WriteChannel;
  readonly conversationId: UUID | null;
  readonly agentId: string | null;
  readonly fieldName: string | null;
  readonly reason: string;
  readonly payloadHash: string;
}

export interface WriteRejectionsRepo {
  /** Append the caller's rejections in one transaction. */
  record(rows: ReadonlyArray<WriteRejectionInput>): Promise<void>;
  /** Newest first, at most `limit` (≤ 200). */
  list(limit?: number): Promise<ReadonlyArray<WriteRejectionRow>>;
}

interface WriteRejectionRowDb {
  id: UUID;
  user_id: UUID;
  channel: WriteChannel;
  conversation_id: UUID | null;
  agent_id: string | null;
  field_name: string | null;
  reason: string;
  payload_hash: string;
  created_at: Date;
}

export function writeRejectionsRepo(tenant: Tenant, user: User): WriteRejectionsRepo {
  return {
    async record(rows) {
      if (rows.length === 0) return;
      await withTenantTransaction(tenant, user, async (tx) => {
        for (const row of rows) {
          await tx.query(
            `INSERT INTO write_rejections
               (tenant_id, user_id, channel, conversation_id, agent_id, field_name, reason, payload_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [tenant.id, user.id, row.channel, row.conversationId, row.agentId, row.fieldName, row.reason, row.payloadHash],
          );
        }
      });
    },

    async list(limit = 50) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<WriteRejectionRowDb>(
          `SELECT id, user_id, channel, conversation_id, agent_id, field_name, reason, payload_hash, created_at
             FROM write_rejections
            WHERE tenant_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2`,
          [tenant.id, Math.min(Math.max(1, Math.trunc(limit)), 200)],
        );
        return res.rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          channel: row.channel,
          conversationId: row.conversation_id,
          agentId: row.agent_id,
          fieldName: row.field_name,
          reason: row.reason,
          payloadHash: row.payload_hash,
          createdAt: row.created_at.toISOString(),
        }));
      });
    },
  };
}
