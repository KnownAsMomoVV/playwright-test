# AI Browser Agent with Chat (DeepSeek + Playwright + Bun)

This agent now has a **think + verify** loop so it is less likely to stop too early.

## Smarter behavior added

- **Cookie-consent helper**: before each AI step, the agent tries common accept-cookie buttons automatically (helps with YouTube consent screens).
- **Goal rewrite step**: AI rewrites your prompt into a structured objective before acting.
- **Action planner step**: AI decides each browser action (`fill`, `click`, `press`, `extract`, etc.).
- **Verifier step**: a second AI pass checks if the goal is actually complete.
- **Outcome-aware screenshot**:
  - `automation-final.png` when goal verified complete.
  - `automation-partial.png` when not complete.

This helps with cases like “find newest video”, where it should search, open, and verify instead of stopping early.

## Setup (Bun)

```bash
bun install
cp .env.example .env
```

Put your key in `.env`:

```bash
DEEPSEEK_API_KEY=your_real_key
```

## Run chat mode (default)

```bash
bun run start --headed
```

Example prompt:

- `go to youtube, find the newest cdawgva video, open it, and screenshot it`

## One-shot mode

```bash
bun run start --one-shot --task "Go to YouTube, find newest cdawgva video, open it, and screenshot it"
```

## Useful flags

- `--max-steps 20` for harder tasks.
- `--url "https://www.youtube.com"` to start directly on YouTube.
- `--no-screenshot` to skip image output.
- `--dry-run` to validate config only.

If Playwright browser is missing:

```bash
bunx playwright install chromium
```
