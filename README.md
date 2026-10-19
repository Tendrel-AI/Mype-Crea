<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/edc460b0-60ec-4ba7-887a-d754e4d869a5

`LLM_PROVIDER` selects the deployment-wide provider for text-model calls and defaults to `openrouter`. Set it to `anthropic` to use Haiku 5.5 for extraction and the evaluation judge, and Sonnet 5.5 for responses. You can override each extractor and responder model with `OPENROUTER_EXTRACTOR_MODEL`, `OPENROUTER_RESPONDER_MODEL`, `ANTHROPIC_EXTRACTOR_MODEL`, and `ANTHROPIC_RESPONDER_MODEL`; the defaults are shown in `.env.example`. OpenRouter values use `provider/model` slugs, and Anthropic values use direct `claude-...` model IDs. Overrides must support the request features used for their task. Set `EVAL_JUDGE_MODEL` separately to override the judge. Restart the deployment after changing provider or model settings. Image generation continues to use `FAL_KEY` independently.

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Copy `.env.example` to `.env.local`. Set `LLM_PROVIDER` to `openrouter` or `anthropic`, then set only the matching provider key (`OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`).
3. Run the app:
   `npm run dev`

## Continuous integration (KAN-14)

GitHub Actions runs on pull requests targeting `developer` and pushes to `developer`.
The initial checks are a clean `npm ci` install, ESLint, TypeScript, unit tests,
and a production build. The workflow also starts an isolated PostgreSQL service,
applies the migrations, and verifies that the application connection uses
`app_user` without `BYPASSRLS`. It never reads `.env.local`, production credentials,
or service secrets.

The initial unit test command excludes `*.integration.test.ts` and the real-model
eval suite. KAN-17 will add the two-tenant integration suite to the isolated CI
database and make it a required check. Real LLM and image calls and LangSmith
trace uploads remain manual; no paid credentials are provided to CI.

To block merges on failure, a repository administrator must protect `developer`
and require the five CI job checks: `Lint`, `TypeScript`, `Unit tests`,
`Database migrations`, and `Production build`. The workflow reports failures
even before branch protection is enabled.

The CI decision and follow-on work are tracked in
[KAN-61](https://matyaslopz.atlassian.net/browse/KAN-61),
[KAN-14](https://matyaslopz.atlassian.net/browse/KAN-14), and
[KAN-17](https://matyaslopz.atlassian.net/browse/KAN-17).
