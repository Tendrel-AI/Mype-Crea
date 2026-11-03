# KAN-61: initial CI policy

Status: reversible implementation default authorized on 2026-10-20. This records the repository's current CI scope; branch protection and production policy still require owner review.

- Provider: the existing GitHub Actions workflow. It runs for pull requests into `developer` and pushes to `developer`.
- Checks: clean install, lint, TypeScript, unit tests without paid providers, production build, migrations on an isolated PostgreSQL 16 service, and an `app_user` role/RLS check. KAN-17 adds the two-tenant isolation suite to that database job.
- Database: CI uses only its temporary `_ci` database. It never loads `.env.local` or connects to the developer or pilot database.
- External calls: no LLM/image credentials or real-model evals in automatic CI. Those runs need a separate budget and authorization.
- Evidence: retain the GitHub Actions job result and attach its URL to KAN-14/KAN-17. A failed job is visible; a required merge gate depends on repository branch-protection settings, which have not been verified here.

Production deployment triggers, preview environments, and the regulatory gate from KAN-59 remain open. This CI default does not select a deployment provider or authorize a pilot rollout.

## Merge gate and evidence (owner decision, 2026-11-02)

- GitHub cannot enforce required checks here: the repository is private on the Free plan, so branch protection and rulesets are refused. The owner chose **report-only**. CI reports pass/fail on every PR into and push to `developer`, and the owner does not merge to `main` while a job is red. The regulatory golden-set job follows the same rule once KAN-59 adds it (see `pipeline/decisions/KAN-68-regulatory-gate-policy.md`).
- Passing run: <https://github.com/Tendrel-AI/Mype-Crea/actions/runs/41567547821> (push to `developer`, merge `d45441d`; all five jobs green).
- Failure-reporting proof: throwaway PR #7 added a test that fails on purpose. Run <https://github.com/Tendrel-AI/Mype-Crea/actions/runs/41567590714> shows the Unit tests job failing while the other jobs pass. The PR was closed without merging and its branch deleted.
