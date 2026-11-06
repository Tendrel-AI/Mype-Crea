/**
 * KAN-42 (SYS-07): read-only conversation trace and pilot metric samples (owner decision
 * 2026-11-02, pipeline/decisions/KAN-42-trace-access-metrics.md). No new table: every event
 * comes from rows the app already writes.
 *
 *  - `app.conversation_trace_events(tenant, conversation)` is the ONE definition of the
 *    timeline. SECURITY INVOKER: as app_user, RLS decides what the caller sees, and every branch
 *    joins the conversation the caller can see, so tenant-axis-only tables (agent_tasks,
 *    llm_calls, usage_reservations) never leak another member's rows. Each event splits into
 *    `meta` (ids, timestamps, statuses, models, versions, latencies, tokens, costs, field names
 *    and sources) and `content` (message text, brief values, prompts, payloads, user ids).
 *  - `app.platform_conversation_trace` returns only `meta` to an active platform actor
 *    (SECURITY DEFINER, row_security off, same posture as `app.platform_monthly_metrics`).
 *  - `app.platform_trace_sample` picks N random conversations per tenant for a month.
 *  - `app.platform_pilot_metric_samples` returns per-turn / per-task latencies and per-set
 *    costs (numbers and timestamps only) for the metrics report.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION app.conversation_trace_events(target_tenant uuid, target_conversation uuid)
    RETURNS TABLE (seq bigint, occurred_at timestamptz, kind text, ref_id uuid, meta jsonb, content jsonb)
    LANGUAGE sql STABLE
    SET search_path = pg_catalog, public, app
    AS $fn$
      WITH conv AS (
        SELECT c.* FROM public.conversations c
         WHERE c.tenant_id = target_tenant AND c.id = target_conversation
      ), tasks AS (
        SELECT t.*, encode(sha256(convert_to(t.requirements_snapshot::text, 'UTF8')), 'hex') AS input_fingerprint
          FROM public.agent_tasks t JOIN conv c ON t.tenant_id = c.tenant_id AND t.conversation_id = c.id
      ), events AS (
        SELECT c.started_at AS at, 0 AS rank, 'conversation' AS kind, c.id AS ref,
          jsonb_build_object('status', c.status, 'configurationState', c.configuration_state,
            'releaseId', c.ai_release_id, 'releaseContentHash', r.content_hash,
            'releaseFrozenAt', r.frozen_at, 'completedAt', c.completed_at,
            -- Current brief provenance: field names, status and the writing source, never values.
            'brief', (SELECT coalesce(jsonb_agg(jsonb_build_object('agentId', a.key, 'fieldName', f.key,
                        'status', f.value->>'status', 'source', f.value->>'source') ORDER BY a.key, f.key), '[]'::jsonb)
                        FROM jsonb_each(CASE WHEN jsonb_typeof(c.agent_states) = 'object' THEN c.agent_states ELSE '{}'::jsonb END) a
                        CROSS JOIN LATERAL jsonb_each(
                          coalesce(CASE WHEN jsonb_typeof(a.value->'requiredFields') = 'object' THEN a.value->'requiredFields' END, '{}'::jsonb)
                          || coalesce(CASE WHEN jsonb_typeof(a.value->'optionalFields') = 'object' THEN a.value->'optionalFields' END, '{}'::jsonb)) f)) AS meta,
          jsonb_build_object('userId', c.user_id, 'agentStates', c.agent_states) AS content
          FROM conv c LEFT JOIN public.ai_releases r ON r.tenant_id = c.tenant_id AND r.id = c.ai_release_id
        UNION ALL
        SELECT ta.accepted_at, 1, 'terms_acceptance', ta.id,
          jsonb_build_object('termsVersion', ta.terms_version), NULL
          FROM public.terms_acceptances ta JOIN conv c ON ta.tenant_id = c.tenant_id AND ta.user_id = c.user_id
        UNION ALL
        SELECT t.created_at, 10, 'turn', t.id,
          jsonb_build_object('requestId', t.request_id, 'stage', t.stage, 'releaseId', t.release_id,
            'failureCategory', t.failure_category, 'recoverable', t.recoverable,
            'completedAt', t.completed_at,
            'durationMs', CASE WHEN t.completed_at IS NOT NULL THEN round(extract(epoch FROM t.completed_at - t.created_at) * 1000) END,
            'deltaSource', t.payload->'delta'->>'source',
            'fields', (SELECT coalesce(jsonb_agg(jsonb_build_object('agentId', a.key, 'fieldName', f.key,
                         'confidence', f.value->'confidence') ORDER BY a.key, f.key), '[]'::jsonb)
                         FROM jsonb_each(CASE WHEN jsonb_typeof(t.payload->'delta'->'fields') = 'object' THEN t.payload->'delta'->'fields' ELSE '{}'::jsonb END) a
                         CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(a.value) = 'object' THEN a.value ELSE '{}'::jsonb END) f),
            'intentKinds', jsonb_path_query_array(coalesce(t.payload->'delta'->'intents', '[]'::jsonb), 'lax $[*].kind'),
            'decisionKinds', jsonb_path_query_array(coalesce(t.payload->'decisions', '[]'::jsonb), 'lax $[*].kind')),
          jsonb_build_object('input', t.input_content, 'response', t.response_content, 'payload', t.payload)
          FROM public.ai_turns t JOIN conv c ON t.tenant_id = c.tenant_id AND t.conversation_id = c.id
        UNION ALL
        SELECT m.created_at, 11, 'message', m.id,
          jsonb_build_object('role', m.role, 'generationStatus', m.generation_status, 'turnId', m.ai_turn_id,
            'completedAt', m.completed_at),
          jsonb_build_object('content', m.content)
          FROM public.messages m JOIN conv c ON m.tenant_id = c.tenant_id AND m.conversation_id = c.id
        UNION ALL
        SELECT a.started_at, 12, 'attempt', a.id,
          jsonb_build_object('turnId', a.turn_id, 'purpose', a.purpose, 'attemptNumber', a.attempt_number,
            'primaryProfileId', a.primary_profile_id, 'effectiveProfileId', a.effective_profile_id,
            'provider', a.provider, 'model', a.model, 'modelRevision', a.model_revision, 'releaseId', a.release_id,
            'status', a.status, 'failureCategory', a.failure_category, 'providerStatus', a.provider_status,
            'inputTokens', a.input_tokens, 'outputTokens', a.output_tokens, 'latencyMs', a.latency_ms,
            'costAmount', a.cost_amount, 'costCurrency', a.cost_currency, 'costSource', a.cost_source,
            'pricingVersion', a.pricing_version, 'finishedAt', a.finished_at),
          jsonb_build_object('request', a.request_content, 'response', a.response_content)
          FROM public.ai_turn_attempts a JOIN conv c ON a.tenant_id = c.tenant_id AND a.conversation_id = c.id
        UNION ALL
        SELECT l.occurred_at, 13, 'llm_call', l.id,
          jsonb_build_object('provider', l.provider, 'purpose', l.purpose, 'model', l.model,
            'modelRevision', l.model_revision, 'promptVersion', l.prompt_version, 'agentTaskId', l.agent_task_id,
            'inputTokens', l.input_tokens, 'outputTokens', l.output_tokens, 'latencyMs', l.latency_ms),
          NULL
          FROM public.llm_calls l JOIN conv c ON l.tenant_id = c.tenant_id
         WHERE l.conversation_id = c.id OR l.agent_task_id IN (SELECT id FROM tasks)
        UNION ALL
        SELECT n.created_at, 14, 'notice', n.id,
          jsonb_build_object('turnId', n.turn_id, 'code', n.code),
          jsonb_build_object('content', n.content)
          FROM public.ai_turn_notices n JOIN conv c ON n.tenant_id = c.tenant_id AND n.conversation_id = c.id
        UNION ALL
        SELECT w.created_at, 15, 'write_rejection', w.id,
          jsonb_build_object('channel', w.channel, 'agentId', w.agent_id, 'fieldName', w.field_name, 'reason', w.reason),
          jsonb_build_object('userId', w.user_id, 'payloadHash', w.payload_hash)
          FROM public.write_rejections w JOIN conv c ON w.tenant_id = c.tenant_id AND w.conversation_id = c.id
        UNION ALL
        SELECT u.created_at, 16, 'usage_reservation', u.id,
          jsonb_build_object('kind', u.kind, 'status', u.status, 'denialReason', u.denial_reason,
            'estimatedCostUsd', u.estimated_cost_usd, 'actualCostUsd', u.actual_cost_usd, 'outcome', u.outcome,
            'pricingVersion', u.pricing_version, 'provider', u.provider, 'model', u.model,
            'turnId', u.turn_id, 'attemptId', u.attempt_id, 'agentTaskId', u.agent_task_id, 'settledAt', u.settled_at),
          jsonb_build_object('userId', u.user_id)
          FROM public.usage_reservations u JOIN conv c ON u.tenant_id = c.tenant_id AND u.created_at >= c.started_at
         WHERE u.conversation_id = c.id OR u.agent_task_id IN (SELECT id FROM tasks)
        UNION ALL
        SELECT t.created_at, 20, 'task', t.id,
          jsonb_build_object('agentId', t.agent_id, 'agentCardVersion', t.agent_card_version, 'status', t.status,
            'commandId', t.idempotency_key, 'attempts', t.attempts, 'iterationNumber', t.iteration_number,
            'iterationTrigger', t.iteration_trigger, 'parentTaskId', t.parent_task_id, 'iterationRootId', t.iteration_root_id,
            'inputFingerprint', t.input_fingerprint, 'dispatchedAt', t.dispatched_at),
          jsonb_build_object('requirementsSnapshot', t.requirements_snapshot)
          FROM tasks t
        UNION ALL
        SELECT t.completed_at, 21, 'task_settled', t.id,
          jsonb_build_object('agentId', t.agent_id, 'status', t.status, 'errorCategory', t.error_category,
            'errorKind', t.error->>'kind',
            'durationMs', round(extract(epoch FROM t.completed_at - t.created_at) * 1000)),
          jsonb_build_object('error', t.error)
          FROM tasks t WHERE t.completed_at IS NOT NULL
        UNION ALL
        SELECT d.created_at, 22, 'deliverable', d.id,
          jsonb_build_object('kind', d.kind, 'agentTaskId', d.agent_task_id, 'artifactKind', d.artifact_kind,
            'inputFingerprint', t.input_fingerprint, 'stored', d.storage_key IS NOT NULL,
            'selectedAt', d.selected_at, 'supersededBy', d.superseded_by),
          jsonb_build_object('contentUrl', d.content_url, 'storageKey', d.storage_key,
            'contentInline', d.content_inline, 'artifactMetadata', d.artifact_metadata)
          FROM public.deliverables d JOIN conv c ON d.tenant_id = c.tenant_id AND d.conversation_id = c.id
          LEFT JOIN tasks t ON t.id = d.agent_task_id
        UNION ALL
        SELECT e.created_at, 23, 'outbox_event', NULL::uuid,
          jsonb_build_object('eventId', e.event_id, 'eventKind', e.kind, 'taskId', e.task_id, 'turnId', e.turn_id,
            'acknowledgedAt', e.acknowledged_at),
          jsonb_build_object('payload', e.payload)
          FROM public.ai_turn_events e JOIN conv c ON e.tenant_id = c.tenant_id AND e.conversation_id = c.id
        UNION ALL
        SELECT ap.approved_at, 30, 'approval', ap.id,
          jsonb_build_object('deliverableKind', ap.deliverable_kind, 'deliverableId', ap.deliverable_id,
            'replacedDeliverableId', ap.replaced_deliverable_id, 'eventSeq', ap.event_seq),
          jsonb_build_object('approvedBy', ap.approved_by)
          FROM public.deliverable_approvals ap JOIN conv c ON ap.tenant_id = c.tenant_id AND ap.conversation_id = c.id
        UNION ALL
        SELECT sm.marked_at, 31, 'stale_mark', sm.id,
          jsonb_build_object('deliverableKind', sm.deliverable_kind, 'eventSeq', sm.event_seq),
          jsonb_build_object('markedBy', sm.marked_by)
          FROM public.deliverable_stale_marks sm JOIN conv c ON sm.tenant_id = c.tenant_id AND sm.conversation_id = c.id
      )
      SELECT row_number() OVER w, e.at, e.kind, e.ref, e.meta, e.content
        FROM events e
      WINDOW w AS (ORDER BY e.at, e.rank, e.ref::text, e.meta->>'eventId')
      ORDER BY 1
    $fn$;
    REVOKE ALL ON FUNCTION app.conversation_trace_events(uuid, uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.conversation_trace_events(uuid, uuid) TO app_user;

    CREATE FUNCTION app.platform_conversation_trace(target_tenant uuid, target_conversation uuid)
    RETURNS TABLE (seq bigint, occurred_at timestamptz, kind text, ref_id uuid, meta jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    SET row_security = off
    AS $fn$
    BEGIN
      IF NOT app.is_platform_actor() THEN RAISE EXCEPTION 'active platform actor context is required'; END IF;
      RETURN QUERY SELECT e.seq, e.occurred_at, e.kind, e.ref_id, e.meta
        FROM app.conversation_trace_events(target_tenant, target_conversation) e;
    END $fn$;
    REVOKE ALL ON FUNCTION app.platform_conversation_trace(uuid, uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.platform_conversation_trace(uuid, uuid) TO app_user;

    CREATE FUNCTION app.platform_trace_sample(requested_month date, per_tenant integer)
    RETURNS TABLE (tenant_id uuid, conversation_id uuid)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    SET row_security = off
    AS $fn$
    DECLARE month_start timestamptz; month_end timestamptz;
    BEGIN
      IF requested_month IS NULL OR date_trunc('month', requested_month)::date <> requested_month THEN
        RAISE EXCEPTION 'requested_month must be the first day of a calendar month';
      END IF;
      IF per_tenant IS NULL OR per_tenant < 1 OR per_tenant > 100 THEN
        RAISE EXCEPTION 'per_tenant must be between 1 and 100';
      END IF;
      IF NOT app.is_platform_actor() THEN RAISE EXCEPTION 'active platform actor context is required'; END IF;
      month_start := requested_month::timestamp AT TIME ZONE 'America/Lima';
      month_end := (requested_month + interval '1 month')::timestamp AT TIME ZONE 'America/Lima';
      RETURN QUERY SELECT s.tenant_id, s.id FROM (
        SELECT c.tenant_id, c.id, row_number() OVER (PARTITION BY c.tenant_id ORDER BY random()) AS pick
          FROM public.conversations c
         WHERE c.started_at >= month_start AND c.started_at < month_end
      ) s WHERE s.pick <= per_tenant ORDER BY s.tenant_id, s.id;
    END $fn$;
    REVOKE ALL ON FUNCTION app.platform_trace_sample(date, integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.platform_trace_sample(date, integer) TO app_user;

    CREATE FUNCTION app.platform_pilot_metric_samples(range_start timestamptz, range_end timestamptz)
    RETURNS TABLE (tenant_id uuid, metric text, subject text, started_at timestamptz, value numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    SET row_security = off
    AS $fn$
    BEGIN
      IF range_start IS NULL OR range_end IS NULL OR range_end <= range_start OR range_end - range_start > interval '366 days' THEN
        RAISE EXCEPTION 'range must be non-empty and at most 366 days';
      END IF;
      IF NOT app.is_platform_actor() THEN RAISE EXCEPTION 'active platform actor context is required'; END IF;
      RETURN QUERY
      SELECT t.tenant_id, CASE WHEN t.stage = 'responded' AND t.completed_at IS NOT NULL THEN 'turn_latency_ms' ELSE 'turn_not_responded' END,
             NULL::text, t.created_at,
             CASE WHEN t.stage = 'responded' AND t.completed_at IS NOT NULL
                  THEN round(extract(epoch FROM t.completed_at - t.created_at) * 1000) ELSE 1 END
        FROM public.ai_turns t
       WHERE t.created_at >= range_start AND t.created_at < range_end
      UNION ALL
      SELECT a.tenant_id, CASE a.status WHEN 'completed' THEN 'deliverable_latency_ms' ELSE 'task_failed' END,
             a.agent_id, a.created_at,
             CASE a.status WHEN 'completed' THEN round(extract(epoch FROM a.completed_at - a.created_at) * 1000) ELSE 1 END
        FROM public.agent_tasks a
       WHERE a.created_at >= range_start AND a.created_at < range_end
         AND a.completed_at IS NOT NULL AND a.status IN ('completed', 'failed')
      UNION ALL
      -- A set = a conversation with at least one completed deliverable; its cost is every
      -- non-denied reservation of the conversation (settled amount, else the estimate).
      SELECT c.tenant_id, 'set_cost_usd', NULL::text, c.started_at,
             coalesce((SELECT sum(coalesce(u.actual_cost_usd, u.estimated_cost_usd))
                FROM public.usage_reservations u
               WHERE u.tenant_id = c.tenant_id AND u.status <> 'denied' AND u.created_at >= c.started_at
                 AND (u.conversation_id = c.id OR u.agent_task_id IN (
                   SELECT x.id FROM public.agent_tasks x WHERE x.tenant_id = c.tenant_id AND x.conversation_id = c.id))), 0)
        FROM public.conversations c
       WHERE c.started_at >= range_start AND c.started_at < range_end
         AND EXISTS (SELECT 1 FROM public.agent_tasks x
                      WHERE x.tenant_id = c.tenant_id AND x.conversation_id = c.id AND x.status = 'completed');
    END $fn$;
    REVOKE ALL ON FUNCTION app.platform_pilot_metric_samples(timestamptz, timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.platform_pilot_metric_samples(timestamptz, timestamptz) TO app_user;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS app.platform_pilot_metric_samples(timestamptz, timestamptz);
    DROP FUNCTION IF EXISTS app.platform_trace_sample(date, integer);
    DROP FUNCTION IF EXISTS app.platform_conversation_trace(uuid, uuid);
    DROP FUNCTION IF EXISTS app.conversation_trace_events(uuid, uuid);
  `);
};
