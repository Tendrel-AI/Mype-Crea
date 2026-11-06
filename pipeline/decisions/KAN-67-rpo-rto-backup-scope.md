# KAN-67 — RPO, RTO, and backup scope for the pilot

Status: **approved by the owner on 2026-11-02** (Option B; retention and post-pilot deletion stay open)

## Decision (2026-11-02)

The owner approved the recommendation: **Option B**. This answers the open questions below as follows:

1. **Targets.** RPO ≤ 24 h, and ≈0 for migration-induced loss through a dump taken before every
   production migration. RTO ≤ 2 h. Both apply within pilot operating hours: **weekdays
   09:00–18:00 America/Lima**. Outside those hours there is no restore commitment.
2. **Who.** The owner (Matias) both authorizes and executes every restore. A production restore
   still needs their explicit authorization each time, and it is recorded in the restore log.
   Nobody else may restore production.
3. **Where.** Independent dumps stay in **Railway's region**, with no copies elsewhere for now.
   To confirm with the owner when the dump job is
   built: the inventory found PostgreSQL in `us-east4` and the development `mype-crea-assets`
   bucket in `sjc` (US West), so "Railway's region" must name one of them.
4. **Retention and post-pilot deletion stay OPEN.** They need institutional and legal input
   (Ley 29733). No period is set, and the draft "7 daily + 4 weekly, deleted within 30 days after
   pilot close" is **not** approved. Until it is decided, nothing is deleted on a schedule.

State at approval (KAN-53 inventory, `pipeline/kan-53-rehearsal-2026-11-02.md`): Railway
scheduled backups are not configured yet (KAN-83 is open), no independent dump job exists, and
the production environment has no asset bucket. KAN-52 is merged in code (images are copied to
the private bucket when the five `BUCKET_*` variables are set), but no Railway environment sets
them yet. So the targets are agreed but **not met in production** until KAN-83 enables backups
and the scheduled dump exists. The first restore rehearsal ran locally and isolated on
2026-11-02 (runbook: `pipeline/kan-53-restore-runbook.md`). A rehearsal against a real Railway
backup is still owed after KAN-83.

KAN-53 is unblocked on the targets. Its remaining items are listed in the rehearsal log.

## Context

- **Blocks:** KAN-53 (agree RPO/RTO and rehearse a restore of pilot data and assets). KAN-53 is
  itself blocked by KAN-15 (environments/deploy) and KAN-52 (private asset storage), and it
  blocks KAN-49 (pilot execution). KAN-53 AC: inventory existing Railway/storage backups
  *before* adding mechanisms, agree targets "sin inventar objetivos", restore only in an isolated
  environment, and never alter or restore production without specific authorization.
- **Thesis:** P0754 / T021R11 (sprint S9 hardening) includes "ensayo de respaldo (RPO/RTO)" but
  gives **no numeric targets**. RNF-02 (P0386–P0388): own components ≥ 99 % available "durante el
  horario operativo del piloto", and provider failures degrade "sin pérdida de datos". RNF-04
  (T012R03): 100 % of a session trace must be reconstructable. P0576: Ley 29733, with encryption
  in transit and at rest aligned with ISO/IEC 27000. P0657: Postgres is the source of truth,
  Redis is ephemeral, and assets live in an S3-compatible Railway bucket.
- **Current reality** (`pipeline/kan-62-topology.md`, architecture §2.15/§2.19):
  - Railway project `Tendrel_AI / mype-crea`: Postgres runs in development and production, and a
    `mype-crea-assets` bucket exists. Backups, retention, and encryption settings are
    **not verified**.
  - The app does not use the bucket yet: `deliverables.content_url` stores the **fal.ai URL**
    (third-party hosted, may expire; `src/workers/logo-agent-worker.ts:321`). Until KAN-52 lands,
    generated images effectively have no backup we control.
  - Redis holds only wake-up signals and live state. Pending tasks are recovered from Postgres by
    the periodic scan (KAN-63), so Redis needs no backup.
  - WorkOS is the identity system of record (external). Secrets live in Railway variables.

## Decision needed

1. RPO and RTO for the pilot (and over what hours they apply).
2. Scope: which data and assets are covered, and which are excluded.
3. Mechanism and retention, who may authorize and who executes a restore, and how the rehearsal
   is measured.

## Options

**A. Managed backups only.** Rely on Railway's own Postgres volume backups (schedule to be
confirmed in the inventory). Likely RPO ≤ 24 h, with RTO bounded by Railway restore time
(unmeasured). This is the smallest option: inventory, runbook, and one rehearsal. Risk: the backup
is inside the same provider and project. Restore granularity, and whether a restore can be done
into an isolated environment as KAN-53 requires, are unverified.

**B. Managed backups + independent logical dumps (recommended).** Same as A, plus a scheduled
`pg_dump` (owner role, encrypted) to separate storage, and a mandatory dump before every
production migration (already proposed in KAN-62). Once KAN-52 lands, bucket objects are covered
by object versioning or a periodic copy. Targets: **RPO ≤ 24 h** (≈0 for migration-induced
loss) and **RTO ≤ 2 h within pilot operating hours**. 2 h is roughly the monthly downtime budget
that 99 % of ~200 operating hours allows (RNF-02). Size: small–medium (scheduled job, storage,
runbook, rehearsal script).

**C. Point-in-time recovery.** Continuous WAL archiving to object storage (for example, wal-g). RPO
is minutes and RTO ≤ 1 h. This adds a self-managed component, operator skill requirements, and
cost, which is disproportionate for a pilot with few participants. Consider it for Phase 2.

Deterministic-planner impact: none. A restore must preserve the conversation snapshot
(`conversations.agent_states`), `agent_tasks`, and deliverables together so replayed planner
decisions match. That is a coherence check for the rehearsal.

## Recommendation

**Option B**, with this scope:

| In scope | Excluded / handled elsewhere |
|---|---|
| Full Postgres database: tenant tables, AI config/releases, turn traces, `llm_calls`, platform metadata and audit tables | Redis (ephemeral; rebuilt by KAN-63 recovery) |
| Asset bucket objects, after KAN-52 moves images off fal.ai URLs | fal.ai-hosted URLs (not under our control; documented as a known gap until KAN-52) |
| Inventory of Railway variables and secret owners (names only, not values) | WorkOS users/orgs (external system of record), LangSmith (dev only) |

Rehearsal (KAN-53): restore the latest dump into an isolated database, run migrations status,
the `app_user`/RLS smoke check, and the two-tenant isolation suite. Check
conversation→task→deliverable→asset referential coherence. Record the measured data-loss window
and wall-clock restore time against the targets. Production restore needs explicit owner
authorization each time.

**Needs institutional/legal input:** retention length and deletion of backups after the pilot,
given Ley 29733 consent terms (P0576). The draft default to confirm is 7 daily + 4 weekly copies,
deleted within 30 days after pilot close. Also needed: whether backups may be stored outside
Railway or outside Peru.

## Consequences / follow-up tickets

- Inventory task first (KAN-67 AC1): Railway plan backup schedule, retention, encryption, and
  restore-to-new-service capability.
- Scheduled dump job and an encrypted storage location. Pre-migration dump step in the deploy
  runbook (KAN-15).
- KAN-52 must add asset versioning or copy before assets count as covered.
- Define "pilot operating hours" (also needed to measure RNF-02 in KAN-49).

## Open questions for the owner

1. Approve RPO ≤ 24 h and RTO ≤ 2 h during pilot operating hours? What are those hours?
2. Who authorizes a restore, and who executes it?
3. May independent backups be stored outside Railway, and in which region?
4. Retention and post-pilot deletion: confirm with the institution and legal (Ley 29733).
