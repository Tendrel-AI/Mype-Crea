#!/usr/bin/env bash
# KAN-53 restore rehearsal (runbook: pipeline/kan-53-restore-runbook.md).
#
# Default mode: start a throwaway local PostgreSQL, apply every migration, seed two synthetic
# tenants (scripts/restore-rehearsal-seed.sql), pg_dump it, then restore the dump into a SECOND
# fresh local instance, timing each step and running the coherence checks.
# Dump mode: DUMP_FILE=<pg_dump -Fc file> restores an existing dump instead (for example one
# downloaded from Railway after KAN-83) and runs the target-only checks.
#
# Safety: every connection goes to 127.0.0.1 instances this script creates in a temp directory.
# It refuses to start if any database URL, PGHOST or PGHOSTADDR points to a non-local host, then
# unsets them and every other PG* variable so nothing (.env, dotenv, libpq) can redirect it.
#
#   scripts/restore-rehearsal.sh                         # seeded rehearsal
#   DUMP_FILE=/path/db.dump scripts/restore-rehearsal.sh # restore a given dump
#   Env: SRC_PORT (55432), DST_PORT (55433), KEEP=1 keeps the temp dir and servers,
#        RUN_ISOLATION_SUITE=0 skips the vitest cross-tenant suite.
set -euo pipefail

is_local_host() { [[ "$1" == "127.0.0.1" || "$1" == "localhost" || "$1" == "::1" || "$1" == "" ]]; }
url_host() { local rest="${1#*://}"; rest="${rest#*@}"; rest="${rest%%/*}"; rest="${rest%%\?*}"; echo "${rest%:*}"; }

for var in DATABASE_URL APP_DATABASE_URL MIGRATION_DATABASE_URL; do
  val="${!var:-}"
  if [[ -n "$val" ]] && ! is_local_host "$(url_host "$val")"; then
    echo "REFUSED: $var points to a non-local host. This rehearsal only runs against throwaway local instances." >&2
    exit 2
  fi
done
for var in PGHOST PGHOSTADDR; do
  if ! is_local_host "${!var:-}"; then
    echo "REFUSED: $var is a non-local host. This rehearsal only runs against throwaway local instances." >&2
    exit 2
  fi
done
# Drop every libpq variable (PGHOSTADDR, PGSERVICEFILE, PGSSL*...), not a hand-picked list.
unset DATABASE_URL APP_DATABASE_URL MIGRATION_DATABASE_URL $(compgen -e | grep '^PG' || true)

cd "$(dirname "$0")/.."
for bin in initdb pg_ctl psql pg_dump pg_restore createdb perl; do
  command -v "$bin" >/dev/null || { echo "MISSING: $bin is required" >&2; exit 3; }
done

HOST=127.0.0.1
SRC_PORT="${SRC_PORT:-55432}"
DST_PORT="${DST_PORT:-55433}"
SRC_DB=mype_source_test
DST_DB=mype_restore_test # *_test so the KAN-17 isolation suite accepts it
APP_PASSWORD="rehearsal-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
# Clusters use scram auth, so other local processes cannot read a restored real dump.
export PGPASSWORD="owner-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kan53-rehearsal.XXXXXX")"
LOG="$WORK/rehearsal.log"
FAILS=0

now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
elapsed() { perl -e "printf '%.2f', $2 - $1"; }
log() { echo "$*" | tee -a "$LOG"; }
check() { if [[ "$2" == ok ]]; then log "PASS  $1"; else log "FAIL  $1: $2"; FAILS=$((FAILS + 1)); fi; }
timed() { local name="$1"; shift; local t0; t0=$(now); "$@"; log "TIME  $name: $(elapsed "$t0" "$(now)") s"; }

owner_url() { echo "postgres://postgres:$PGPASSWORD@$HOST:$1/$2"; }
q() { local port="$1" db="$2"; shift 2; psql -X -q -v ON_ERROR_STOP=1 -At -h "$HOST" -p "$port" -U postgres -d "$db" "$@"; }

start_instance() { # name port
  echo "$PGPASSWORD" >"$WORK/pwfile"
  initdb -D "$WORK/$1" -U postgres -A scram-sha-256 --pwfile="$WORK/pwfile" >/dev/null
  rm -f "$WORK/pwfile"
  # TCP on loopback only; unix sockets off (temp paths exceed the 103-byte socket limit on macOS).
  pg_ctl -D "$WORK/$1" -l "$WORK/$1.log" -w \
    -o "-p $2 -c listen_addresses=$HOST -c unix_socket_directories=''" start >/dev/null
}
migrate_source() {
  DATABASE_URL="$(owner_url "$SRC_PORT" "$SRC_DB")" npx --no-install node-pg-migrate up --envPath /dev/null \
    >"$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log" >&2; return 1; }
}
cleanup() {
  # Keep the log (and the asset key list) even when a step aborts the script.
  if [[ -n "${LOG_FILE:-}" && -f "$LOG" ]]; then
    cp "$LOG" "$LOG_FILE"; [[ -f "$WORK/storage-keys.txt" ]] && cp "$WORK/storage-keys.txt" "$LOG_FILE.storage-keys.txt"
  fi
  if [[ "${KEEP:-0}" == 1 ]]; then echo "KEEP=1: servers left running; data in $WORK"; return; fi
  for d in src dst; do [[ -d "$WORK/$d" ]] && pg_ctl -D "$WORK/$d" -m fast stop >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

# Everything compared between source (at dump time) and restore: per-table row count + content
# hash, per-tenant counts, sequences, constraints (incl. NOT VALID), triggers, RLS flags,
# policies, grants and the migration head.
fingerprint() { # port db
  q "$1" "$2" <<'SQL'
SELECT format('SELECT ''table|'' || %L || ''|'' || count(*) || ''|'' || md5(coalesce(string_agg(md5(x::text), '''' ORDER BY md5(x::text)), '''')) FROM public.%I x', relname, relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY relname \gexec
SELECT format('SELECT ''tenant_rows|'' || %L || ''|'' || tenant_id || ''|'' || count(*) FROM public.%I GROUP BY tenant_id ORDER BY tenant_id', table_name, table_name)
  FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name \gexec
SELECT 'sequence|' || sequencename || '|' || coalesce(last_value::text, 'null') FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1;
SELECT 'constraint|' || conrelid::regclass || '|' || conname || '|' || contype::text || '|validated=' || convalidated
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1;
SELECT 'trigger|' || tgrelid::regclass || '|' || tgname || '|enabled=' || tgenabled::text FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1;
SELECT 'rls|' || relname || '|' || relrowsecurity || '|' || relforcerowsecurity
  FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1;
SELECT 'policy|' || tablename || '|' || policyname || '|' || cmd FROM pg_policies ORDER BY 1;
SELECT 'grant|' || table_name || '|' || privilege_type FROM information_schema.role_table_grants WHERE grantee = 'app_user' ORDER BY 1;
SELECT 'migration_head|' || name FROM pgmigrations ORDER BY run_on DESC, id DESC LIMIT 1;
SQL
}

log "# KAN-53 restore rehearsal $(date -u +%Y-%m-%dT%H:%M:%SZ) ($(postgres --version))"
log "workdir: $WORK"

# ---------------------------------------------------------------- source and dump
if [[ -z "${DUMP_FILE:-}" ]]; then
  DUMP="$WORK/source.dump"
  timed "source: initdb + start" start_instance src "$SRC_PORT"
  createdb -h "$HOST" -p "$SRC_PORT" -U postgres "$SRC_DB"
  timed "source: apply migrations" migrate_source
  timed "source: seed two tenants" q "$SRC_PORT" "$SRC_DB" -f scripts/restore-rehearsal-seed.sql
  fingerprint "$SRC_PORT" "$SRC_DB" >"$WORK/source.fingerprint"
  DUMP_STARTED=$(now)
  timed "backup: pg_dump -Fc" pg_dump -Fc -h "$HOST" -p "$SRC_PORT" -U postgres -d "$SRC_DB" -f "$DUMP"
  log "dump size: $(wc -c <"$DUMP" | tr -d ' ') bytes"
  # A write after the backup: it must be missing from the restore (that is the data-loss window).
  q "$SRC_PORT" "$SRC_DB" -c "INSERT INTO messages (tenant_id, conversation_id, user_id, role, content)
    SELECT tenant_id, id, user_id, 'user', 'POST-DUMP MARKER' FROM conversations LIMIT 1"
else
  DUMP="$DUMP_FILE"
  [[ -r "$DUMP" ]] || { echo "DUMP_FILE not readable: $DUMP" >&2; exit 3; }
  log "restoring given dump: $DUMP ($(wc -c <"$DUMP" | tr -d ' ') bytes)"
fi

# ---------------------------------------------------------------- restore (RTO clock)
INCIDENT=$(now)
log "incident declared; RTO clock starts"
timed "restore: initdb + start fresh instance" start_instance dst "$DST_PORT"
# pg_dump does not carry roles: app_user must exist (new password) before its GRANTs restore.
timed "restore: create app_user + database" q "$DST_PORT" postgres \
  -c "CREATE ROLE app_user LOGIN NOBYPASSRLS PASSWORD '$APP_PASSWORD'" -c "CREATE DATABASE $DST_DB"
timed "restore: pg_restore --single-transaction" \
  pg_restore --exit-on-error --single-transaction -h "$HOST" -p "$DST_PORT" -U postgres -d "$DST_DB" "$DUMP"

# ---------------------------------------------------------------- checks
CHECKS_STARTED=$(now)
fingerprint "$DST_PORT" "$DST_DB" >"$WORK/restore.fingerprint"
if [[ -z "${DUMP_FILE:-}" ]]; then
  if diff "$WORK/source.fingerprint" "$WORK/restore.fingerprint" >"$WORK/fingerprint.diff"; then
    check "source-at-dump vs restore: rows, per-tenant counts, content hashes, sequences, constraints, triggers, RLS, policies, grants, migration head ($(wc -l <"$WORK/source.fingerprint" | tr -d ' ') lines)" ok
  else
    check "source-at-dump vs restore fingerprint" "differs, see below"; cat "$WORK/fingerprint.diff" | tee -a "$LOG"
  fi
  grep '^tenant_rows|' "$WORK/restore.fingerprint" | tee -a "$LOG" >/dev/null
  marker=$(q "$DST_PORT" "$DST_DB" -c "SELECT count(*) FROM messages WHERE content = 'POST-DUMP MARKER'")
  [[ "$marker" == 0 ]] && check "post-dump write is absent from the restore (lost, as expected)" ok \
    || check "post-dump write is absent from the restore" "found $marker"
  log "data-loss window (dump start -> incident): $(elapsed "$DUMP_STARTED" "$INCIDENT") s"
fi

head_db=$(grep '^migration_head|' "$WORK/restore.fingerprint" | cut -d'|' -f2)
head_repo=$(ls migrations | sort | tail -1); head_repo="${head_repo%.js}"
[[ "$head_db" == "$head_repo" ]] && check "migration head = repo latest ($head_repo)" ok \
  || check "migration head = repo latest" "db=$head_db repo=$head_repo"

invalid=$(grep -c 'validated=false' "$WORK/restore.fingerprint" || true)
log "INFO  NOT VALID constraints carried over: $invalid ($(grep 'validated=false' "$WORK/restore.fingerprint" | cut -d'|' -f3 | tr '\n' ' '))"

orphans=$(q "$DST_PORT" "$DST_DB" <<'SQL'
SELECT (SELECT count(*) FROM deliverables d LEFT JOIN agent_tasks a ON a.tenant_id = d.tenant_id AND a.id = d.agent_task_id
         WHERE a.id IS NULL OR a.conversation_id <> d.conversation_id)
     + (SELECT count(*) FROM agent_tasks a LEFT JOIN conversations c ON c.tenant_id = a.tenant_id AND c.id = a.conversation_id
         WHERE c.id IS NULL)
     + (SELECT count(*) FROM agent_tasks a LEFT JOIN agent_tasks r ON r.tenant_id = a.tenant_id AND r.id = a.iteration_root_id
         WHERE r.id IS NULL OR r.conversation_id <> a.conversation_id)
     + (SELECT count(*) FROM deliverable_approvals p JOIN deliverables d ON d.tenant_id = p.tenant_id AND d.id = p.deliverable_id
         WHERE d.conversation_id <> p.conversation_id)
     + (SELECT count(*) FROM messages m LEFT JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
         WHERE c.id IS NULL);
SQL
)
[[ "$orphans" == 0 ]] && check "conversation -> task -> deliverable -> approval chain has no orphans" ok \
  || check "conversation -> task -> deliverable chain" "$orphans orphan rows"

# Assets: objects cannot be restored locally. List every key the restored DB references so it
# can be compared with a bucket listing (gap: KAN-52 / KAN-83).
q "$DST_PORT" "$DST_DB" -F ' ' -c "SELECT tenant_id, id, storage_key FROM deliverables WHERE storage_key IS NOT NULL ORDER BY 1, 3" \
  >"$WORK/storage-keys.txt"
bad_keys=$(q "$DST_PORT" "$DST_DB" -c "SELECT count(*) FROM deliverables WHERE storage_key IS NOT NULL AND NOT starts_with(storage_key, 'tenants/' || tenant_id || '/')")
provider_only=$(q "$DST_PORT" "$DST_DB" -c "SELECT count(*) FROM deliverables WHERE storage_key IS NULL AND content_url IS NOT NULL")
log "INFO  deliverable storage keys listed: $(wc -l <"$WORK/storage-keys.txt" | tr -d ' ') (file: storage-keys.txt); provider-URL-only deliverables: $provider_only"
[[ "$bad_keys" == 0 ]] && check "every storage key sits under its own tenant prefix" ok || check "storage key prefixes" "$bad_keys outside tenant prefix"
head -3 "$WORK/storage-keys.txt" | sed 's/^/      /' | tee -a "$LOG"

# RLS as app_user: no context sees nothing; each tenant's admin context sees only its own rows.
role=$(q "$DST_PORT" "$DST_DB" -c "SELECT rolcanlogin AND NOT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = 'app_user'")
[[ "$role" == t ]] && check "app_user can log in, no BYPASSRLS, not superuser" ok || check "app_user role posture" "got '$role'"
# tenant:admin:expected triples. app_user reads with the widest legitimate context (an active
# tenant admin) and must see exactly the owner's count of that tenant's rows in the tables it
# may read. Tenants without an active admin are checked for leaks only.
expected_sql=$(q "$DST_PORT" "$DST_DB" -c "SELECT string_agg(format('(SELECT count(*) FROM public.%I WHERE tenant_id = t.id)', c.relname), ' + ')
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND has_table_privilege('app_user', c.oid, 'SELECT')")
tenants=$(q "$DST_PORT" "$DST_DB" -c "SELECT string_agg(t.id || ':' || coalesce(adm.id::text, '') || ':' ||
  CASE WHEN adm.id IS NULL THEN '' ELSE ($expected_sql)::text END, ',') FROM tenants t
  LEFT JOIN LATERAL (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.role = 'admin' AND u.status = 'active'
                      ORDER BY u.created_at LIMIT 1) adm ON true")
[[ -n "$tenants" ]] || check "restored database has tenants" "tenants table is empty"
rls_out=$(psql -X -q -v ON_ERROR_STOP=1 -At "postgres://app_user:$APP_PASSWORD@$HOST:$DST_PORT/$DST_DB" \
  -v tenants="$tenants" 2>&1 <<'SQL'
SET rehearsal.tenants = :'tenants';
-- Tenant-keyed public tables app_user may read (oid-based privilege check).
CREATE TEMP VIEW tenant_tables AS
  SELECT c.relname::text FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND has_table_privilege(c.oid, 'SELECT');
DO $$
DECLARE tbl text; ten text; pair text; leaked bigint; own bigint; total bigint; checked int := 0;
BEGIN
  IF current_user <> 'app_user' THEN RAISE EXCEPTION 'not connected as app_user'; END IF;
  FOR tbl IN SELECT * FROM pg_temp.tenant_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO leaked;
    IF leaked <> 0 THEN RAISE EXCEPTION 'no tenant context: % rows visible in %', leaked, tbl; END IF;
  END LOOP;
  FOREACH pair IN ARRAY string_to_array(current_setting('rehearsal.tenants'), ',') LOOP
    ten := split_part(pair, ':', 1);
    PERFORM set_config('app.tenant_id', ten, true), set_config('app.user_id', split_part(pair, ':', 2), true),
            set_config('app.is_tenant_admin', 'true', true);
    total := 0;
    FOR tbl IN SELECT * FROM pg_temp.tenant_tables LOOP
      EXECUTE format('SELECT count(*) FILTER (WHERE tenant_id::text <> $1), count(*) FROM public.%I', tbl)
        INTO leaked, own USING ten;
      IF leaked <> 0 THEN RAISE EXCEPTION 'tenant % sees % foreign rows in %', ten, leaked, tbl; END IF;
      total := total + own; checked := checked + 1;
    END LOOP;
    IF split_part(pair, ':', 3) <> '' AND total <> split_part(pair, ':', 3)::bigint THEN
      RAISE EXCEPTION 'tenant % admin sees % own rows, owner counts %', ten, total, split_part(pair, ':', 3);
    END IF;
    RAISE NOTICE 'tenant % sees % own rows, 0 foreign', ten, total;
  END LOOP;
  IF checked = 0 THEN RAISE EXCEPTION 'no (tenant, table) pairs checked'; END IF;
  RAISE NOTICE 'checked % (tenant, table) pairs', checked;
END $$;
SQL
) && rls_ok=ok || rls_ok="$rls_out"
{ echo "$rls_out" | grep NOTICE || true; } | sed 's/^/      /' | tee -a "$LOG"
check "app_user under RLS: 0 rows without context; per tenant (admin context) 0 foreign rows and all own rows" "$rls_ok"

RESTORED=$(now)
log "TIME  restore: verification checks: $(elapsed "$CHECKS_STARTED" "$RESTORED") s"
log "RTO (incident -> restored and verified): $(elapsed "$INCIDENT" "$RESTORED") s"

if [[ "${RUN_ISOLATION_SUITE:-1}" == 1 ]]; then
  t0=$(now)
  if env DATABASE_URL="$(owner_url "$DST_PORT" "$DST_DB")" \
       APP_DATABASE_URL="postgres://app_user:$APP_PASSWORD@$HOST:$DST_PORT/$DST_DB" \
       npx --no-install vitest run src/core/__tests__/cross-tenant-isolation.integration.test.ts >"$WORK/isolation.log" 2>&1; then
    check "KAN-17 cross-tenant isolation suite on the restored DB ($(grep -Eo 'Tests +[0-9]+ passed' "$WORK/isolation.log" | head -1))" ok
  else
    check "KAN-17 cross-tenant isolation suite" "failed, see isolation.log"; tail -30 "$WORK/isolation.log" | tee -a "$LOG"
  fi
  log "TIME  extended: isolation suite: $(elapsed "$t0" "$(now)") s"
fi

log "RESULT: $FAILS failed check(s)"
exit $((FAILS > 0))
