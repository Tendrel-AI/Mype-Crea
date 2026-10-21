# KAN-61: initial CI policy

Status: reversible implementation default authorized on 2026-10-20. This records the repository's current CI scope; branch protection and production policy still require owner review.

- Provider: the existing GitHub Actions workflow. It runs for pull requests into `developer` and pushes to `developer`.
- Checks: clean install, lint, TypeScript, unit tests without paid providers, production build, migrations on an isolated PostgreSQL 16 service, and an `app_user` role/RLS check. KAN-17 adds the two-tenant isolation suite to that database job.
- Database: CI uses only its temporary `_ci` database. It never loads `.env.local` or connects to the developer or pilot database.
- External calls: no LLM/image credentials or real-model evals in automatic CI. Those runs need a separate budget and authorization.
- Evidence: retain the GitHub Actions job result and attach its URL to KAN-14/KAN-17. A failed job is visible; a required merge gate depends on repository branch-protection settings, which have not been verified here.

Production deployment triggers, preview environments, and the regulatory gate from KAN-59 remain open. This CI default does not select a deployment provider or authorize a pilot rollout.
