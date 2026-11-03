-- KAN-53 restore rehearsal: synthetic two-tenant seed for a THROWAWAY local database.
-- Run as the schema owner (superuser, so RLS is bypassed). Never run against a real database.
-- Each tenant gets: admin + member, 3 conversations with agent_states, messages, a root logo
-- task plus one iteration, URL deliverables with private-bucket storage keys, one approval,
-- one stale mark, terms acceptances, llm_calls and an AI config audit event.
DO $$
DECLARE
  label text;
  t uuid; admin_id uuid; member_id uuid; conv uuid; root uuid; iter uuid; d1 uuid; d2 uuid;
  n int;
BEGIN
  FOREACH label IN ARRAY ARRAY['A', 'B'] LOOP
    t := gen_random_uuid(); admin_id := gen_random_uuid(); member_id := gen_random_uuid();
    INSERT INTO tenants (id, kind, name) VALUES (t, 'institutional', 'Rehearsal tenant ' || label);
    INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES
      (admin_id,  t, 'rehearsal-admin-'  || label, 'admin-'  || lower(label) || '@example.invalid', 'admin',  'active'),
      (member_id, t, 'rehearsal-member-' || label, 'member-' || lower(label) || '@example.invalid', 'member', 'active');
    INSERT INTO terms_acceptances (tenant_id, user_id, terms_version) VALUES
      (t, admin_id, 'terminos-v1'), (t, member_id, 'terminos-v1');
    INSERT INTO ai_config_audit_events (tenant_id, actor_user_id, action, metadata)
      VALUES (t, admin_id, 'rehearsal_fixture', jsonb_build_object('tenant', label));

    FOR n IN 1..3 LOOP
      conv := gen_random_uuid();
      INSERT INTO conversations (id, tenant_id, user_id, agent_states)
        VALUES (conv, t, member_id, jsonb_build_object(
          'logo-agent', jsonb_build_object('status', 'completed',
            'slots', jsonb_build_object('business_name', 'Bodega ' || label || n, 'style', 'moderno'))));
      INSERT INTO messages (tenant_id, conversation_id, user_id, role, content)
        SELECT t, conv, member_id, (CASE WHEN i % 2 = 1 THEN 'user' ELSE 'assistant' END)::message_role,
               'Mensaje sintético ' || i || ' de la conversación ' || n || ' (tenant ' || label || ')'
          FROM generate_series(1, 6) AS i;

      root := gen_random_uuid(); iter := gen_random_uuid();
      INSERT INTO agent_tasks (id, tenant_id, conversation_id, agent_id, agent_card_version, status,
                               idempotency_key, iteration_root_id, requirements_snapshot, completed_at)
        VALUES (root, t, conv, 'logo-agent', '1.0.0', 'completed', gen_random_uuid(), root,
                jsonb_build_object('business_name', 'Bodega ' || label || n), now());
      INSERT INTO agent_tasks (id, tenant_id, conversation_id, agent_id, agent_card_version, status,
                               idempotency_key, parent_task_id, iteration_root_id, iteration_number,
                               iteration_trigger, requirements_snapshot, completed_at)
        VALUES (iter, t, conv, 'logo-agent', '1.0.0', 'completed', gen_random_uuid(), root, root, 2,
                'user_regenerate', jsonb_build_object('business_name', 'Bodega ' || label || n), now());

      d1 := gen_random_uuid(); d2 := gen_random_uuid();
      INSERT INTO deliverables (id, tenant_id, conversation_id, agent_task_id, user_id, kind,
                                content_url, artifact_kind, storage_key, selected_at)
        VALUES
        (d1, t, conv, root, member_id, 'logo', 'https://fal.media/files/rehearsal/' || d1 || '.png', 'image',
         'tenants/' || t || '/conversations/' || conv || '/tasks/' || root || '/0.png', NULL),
        (d2, t, conv, iter, member_id, 'logo', 'https://fal.media/files/rehearsal/' || d2 || '.png', 'image',
         'tenants/' || t || '/conversations/' || conv || '/tasks/' || iter || '/0.png', now());
      INSERT INTO deliverable_approvals (tenant_id, conversation_id, user_id, deliverable_kind,
                                         deliverable_id, approved_by)
        VALUES (t, conv, member_id, 'logo', d2, member_id);
      IF n = 3 THEN
        INSERT INTO deliverable_stale_marks (tenant_id, conversation_id, user_id, deliverable_kind, marked_by)
          VALUES (t, conv, member_id, 'logo', member_id);
      END IF;
      INSERT INTO llm_calls (tenant_id, conversation_id, user_id, provider, purpose, model,
                             model_revision, prompt_version, input_tokens, output_tokens, latency_ms)
        VALUES (t, conv, member_id, 'openrouter', 'extractor', 'rehearsal-model', 'r1', 'v1', 100, 20, 300),
               (t, conv, member_id, 'openrouter', 'responder', 'rehearsal-model', 'r1', 'v1', 200, 80, 600);
    END LOOP;
  END LOOP;
END $$;
