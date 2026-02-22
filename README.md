# AI Browser Agent with Chat (DeepSeek + Playwright + Bun)

Yes — you can **just tell DeepSeek what to do** in plain English.

Example request:
- `go to youtube and get me the url of the first video for lo-fi beats`

The AI agent will plan actions, control Playwright, and return extracted output.

## What AI is doing here

DeepSeek is used in two places:

1. **Planner AI** (every step):
   - Reads live page state (title, URL, visible inputs/buttons/links).
   - Chooses the next browser action as JSON (`fill`, `click`, `press`, `extract`, etc.).
   - Playwright executes the action.
2. **Response AI** (after each goal):
   - Summarizes results back to you in chat.
   - Includes extracted output (like video URLs) when available.

## Setup (Bun)

```bash
bun install
cp .env.example .env
```

Add your key in `.env`:

```bash
DEEPSEEK_API_KEY=your_real_key
```

## Start interactive AI chat mode (recommended)

```bash
bun run start --chat --headed
```

Then type goals like:
- `go to youtube and get me the first video url for lo-fi beats`
- `search amazon for iphone 17 case with magsafe`
- `open the first result`

Type `exit` to quit.

## One-shot mode (single goal)

```bash
bun run start --task "Go to YouTube and get the first video URL for lo-fi beats"
```

## Useful flags

- `--chat` interactive AI chat loop.
- `--headed` show browser window.
- `--max-steps 12` max AI actions per goal.
- `--url "https://www.youtube.com"` custom start page.
- `--dry-run` print config only.
- `--no-screenshot` skip `automation-final.png`.

## Environment defaults (`.env`)

- `AUTOMATION_TASK`
- `AUTOMATION_START_URL`
- `AUTOMATION_MAX_STEPS`

If Playwright browsers are missing:

```bash
bunx playwright install chromium
```
