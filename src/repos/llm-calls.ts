/**
 * llm_calls repository — append-only billing/audit log for every LLM call.
 *
 * Per claude/skills/database/SKILL.md:
 *   - llm_calls RLS is tenant-scoped only; user_id may be NULL for unattributed calls.
 *   - Every method runs in withTenantTransaction with the GUCs set.
 *   - There is no findById exposed here — analytics belongs in a separate admin repo.
 */
import type { UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import type { LlmCallInsert } from './models';

const log = loggerFor('repo.llm_calls');

export function llmCallsRepo(tenant: Tenant, user: User | undefined) {
  return {
    /**
     * Append a single llm_call row. Returns the new id.
     * Append-only — no update/delete is exposed.
     */
    async record(input: LlmCallInsert): Promise<UUID> {
      const child = log.child({
        op: 'record',
        tenantId: tenant.id,
        userId: user?.id,
        conversationId: input.conversationId,
        model: input.model,
      });
      child.debug(
        {
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          latencyMs: input.latencyMs,
        },
        'inserting llm_call',
      );
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ id: UUID }>(
          `INSERT INTO llm_calls
             (tenant_id, conversation_id, user_id, agent_task_id,
              model, model_revision, prompt_version,
              input_tokens, output_tokens, latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            tenant.id,
            input.conversationId ?? null,
            user?.id ?? null,
            input.agentTaskId ?? null,
            input.model,
            input.modelRevision,
            input.promptVersion,
            input.inputTokens,
            input.outputTokens,
            input.latencyMs,
          ],
        );
        const id = res.rows[0].id;
        child.info({ id }, 'llm_call recorded');
        return id;
      });
    },
  };
}

export type LlmCallsRepo = ReturnType<typeof llmCallsRepo>;
