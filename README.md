# Fully Automatic AI Playwright Agent (DeepSeek)

This runs as an **autonomous browser agent**.

You give it a goal (example: _"Search Amazon for iPhone 17 cases under $50"_), and it:
1. Opens the browser.
2. Uses DeepSeek each step to decide the next Playwright action.
3. Executes that action automatically.
4. Stops when complete or when max steps is reached.

## Bun-first setup (recommended)

```bash
bun install
cp .env.example .env
```

Put your key in `.env`:

```bash
DEEPSEEK_API_KEY=your_real_key
```

## Run automatically with Bun

```bash
bun run start
```

Default run values:
- Task: `Open Amazon and search for iPhone 17.`
- URL: `https://www.amazon.com/`
- Max steps: `8`

## Custom goal

```bash
bun run start --task "Search Amazon for iPhone 17 case with MagSafe"
```

## Useful flags

- `--headed` show browser window.
- `--max-steps 12` allow longer runs.
- `--url "https://www.amazon.com"` custom start page.
- `--dry-run` print config only.
- `--no-screenshot` skip `automation-final.png`.

## Environment defaults (`.env`)

- `AUTOMATION_TASK`
- `AUTOMATION_START_URL`
- `AUTOMATION_MAX_STEPS`

## Notes for Bun users

- `bun run start` uses the `start` script in `package.json`.
- Bun can read `.env` automatically; this project also supports Node-style env usage.
- If Playwright browsers are missing, run:

```bash
bunx playwright install chromium
```

## Output

- Step-by-step agent action log in terminal.
- Final screenshot: `automation-final.png`.
