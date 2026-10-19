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
