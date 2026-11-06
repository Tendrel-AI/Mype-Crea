# CreaMype

CreaMype is an AI-assisted brand creation and product launch wizard for Peruvian
micro and small businesses. Phase 1 serves one institutional pilot tenant, and
`logo-agent` is the only agent that produces deliverables.

The full setup, environment, testing, deployment, and recovery runbook is in
[`docs/operations.md`](docs/operations.md).

## Stack

Next.js 16 and React 19, PostgreSQL 16 with row-level security, Redis 7 for the
logo worker's wake-up channel, WorkOS AuthKit for sign-in, OpenRouter or the
Anthropic API for text models, fal.ai for images, and LangSmith for evals and
development tracing.

## Local development

Prerequisites: Node.js 20+ (CI uses 22), npm, and Docker Compose.

1. Install dependencies: `npm ci`.
2. Copy `.env.example` to `.env.local`; fill the WorkOS, selected LLM provider, and
   fal.ai credentials needed for the flows you will use. Keep `.env.local` private.
3. Start local PostgreSQL and Redis: `npm run services:up`.
4. Apply database migrations: `npm run migrate:up`.
5. Check the runtime database role and RLS posture:
   `node --env-file=.env.local scripts/db-smoke.mjs`.
6. Start Next.js: `npm run dev`.
7. Before the first conversation, a platform admin creates and activates an AI
   release in `/admin/ai`. See
   [operations, section 5](docs/operations.md#5-llm-providers).

The Compose services bind to loopback only. PostgreSQL data persists in its
Compose named volume; `npm run services:down` stops containers without deleting
that volume. To start them again, use `npm run services:up`.

The app requires `APP_DATABASE_URL` and connects as `app_user`; `DATABASE_URL`
is reserved for migrations and administrative scripts. The initial migration
creates `app_user` with a development-only bootstrap password, shown in
`.env.example`. Rotate that password before using any non-local database and set
the matching `APP_DATABASE_URL`. Never use the local Compose credentials outside
your machine.

Without Redis, the app uses in-process notifiers and `LocalAdapter`, which does
not persist logo deliverables for display. With Redis, the durable logo worker
starts in the Next.js process; there is no separate worker command today.

## LLM providers

`LLM_PROVIDER=openrouter` (default) uses `OPENROUTER_API_KEY`;
`LLM_PROVIDER=anthropic` uses `ANTHROPIC_API_KEY` with Claude Haiku 5.5 for
extraction and Claude Sonnet 5.5 for responses. Only the selected key is
required. Images always use fal.ai (`FAL_KEY`).

Chat turns use the provider and models pinned in the conversation's AI release
(KAN-70). `LLM_PROVIDER` selects the primary provider when a baseline release
is captured, and the provider used by evals. To roll back to OpenRouter, activate
a release whose primary profiles use OpenRouter, or disable Anthropic with
`AI_CONFIG_ANTHROPIC_ENABLED=false` (or in `/admin/ai`) so turns use the
OpenRouter fallback; for evals, set `LLM_PROVIDER=openrouter` and restart.
Details and pending decisions are in
[operations, section 5](docs/operations.md#5-llm-providers).

## Build and production run

`npm run build` produces `.next/standalone`; `npm start` runs its server bound to
all interfaces (`HOSTNAME=0.0.0.0`). The pilot targets Railway
(`Tendrel_AI / mype-crea`). The development deployment is still being verified,
and production is not set up. Liveness is `GET /api/health` and readiness
(PostgreSQL, plus Redis when configured) is `GET /api/health/ready`.
The Railway service runs the pre-deploy command `npm run migrate:deploy`, which
applies pending migrations on every deploy with the admin connection in
`MIGRATION_DATABASE_URL`, and gates traffic on the `/api/health/ready`
healthcheck. Those settings live on the Railway service, not in this repository
(see [operations, section 9](docs/operations.md#9-deployment)). Migrations must be add-only;
see [operations, section 7](docs/operations.md#7-migrations-build-and-start).
There is no asset object-storage adapter yet. Do not treat
these commands as evidence of a deployed pilot. See
[operations, sections 9 and 10](docs/operations.md#9-deployment) and
[`pipeline/kan-62-topology.md`](pipeline/kan-62-topology.md).

## CI

GitHub Actions is configured for pull requests targeting `developer` and pushes
to `developer`. It runs lint, TypeScript, unit tests, a production build, and
migration checks against an isolated PostgreSQL service. The workflow does not
read `.env.local`, use paid provider credentials, or run evals. Repository branch
protection and required check settings must be confirmed separately.

## Focused checks

Run a focused unit check with `npx vitest run <path-to-test>`. Avoid `npm test`
unless you intend to run the full suite, including database integration tests.
`npm run test:integration` loads `.env.local` and may modify the database named
there; use it only with an approved test database.

The `npm run eval*` commands call real LLM providers and cost tokens. **Do not
run an eval without explicit owner approval for that run**, even when keys are
present. With approval, `EVAL_MODEL_PROFILE=cheap` or `free` switches evals to
low-cost models; see
[operations, section 8](docs/operations.md#8-tests-and-evals).
