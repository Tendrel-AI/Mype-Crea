# CreaMype

CreaMype is an AI-assisted brand creation and product launch wizard for Peruvian
micro and small businesses. The live pilot scope is one institutional tenant and
the `logo-agent`.

## Local development

Prerequisites: Node.js 20+, npm, and Docker Compose.

1. Install dependencies: `npm ci`.
2. Copy `.env.example` to `.env.local`; fill the WorkOS, selected LLM provider, and
   fal.ai credentials needed for the flows you will use. Keep `.env.local` private.
3. Start local PostgreSQL and Redis: `npm run services:up`.
4. Apply database migrations: `npm run migrate:up`.
5. Check the runtime database role and RLS posture:
   `node --env-file=.env.local scripts/db-smoke.mjs`.
6. Start Next.js: `npm run dev`.

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

## Build and production run

`npm run build` produces `.next/standalone`; `npm start` runs its server. The
repository does not currently define a production hosting provider, deployment
workflow, public health endpoint, or asset object-storage adapter. Do not treat
these commands as evidence of a deployed pilot. See
[`pipeline/kan-62-topology.md`](pipeline/kan-62-topology.md) for the inventory,
proposed local defaults, open production decisions, and safe operating sequence.

## CI

GitHub Actions is configured for pull requests targeting `developer` and pushes
to `developer`. It runs lint, TypeScript, unit tests, a production build, and
migration checks against an isolated PostgreSQL service. The workflow does not
read `.env.local` or use paid provider credentials. Repository branch protection
and required check settings must be confirmed separately.

## Focused checks

Run a focused unit check with `npx vitest run <path-to-test>`. Avoid `npm test`
unless you intend to run the full suite, including database integration tests.
`npm run test:integration` loads `.env.local` and may modify the database named
there; use it only with an approved test database. The `npm run eval*` commands
call real LLM providers and may incur costs. Do not run either against pilot
services as a routine check.
