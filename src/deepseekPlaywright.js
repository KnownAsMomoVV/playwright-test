import 'dotenv/config';
import { chromium } from 'playwright';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_TASK = 'Open Amazon and search for iPhone 17.';

function parseArgs(argv) {
  const args = {
    task: process.env.AUTOMATION_TASK || DEFAULT_TASK,
    startUrl: process.env.AUTOMATION_START_URL || 'https://www.amazon.com/',
    maxSteps: Number.parseInt(process.env.AUTOMATION_MAX_STEPS || '8', 10),
    headless: true,
    saveScreenshot: true,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--task' && argv[i + 1]) {
      args.task = argv[i + 1];
      i += 1;
    } else if (arg === '--url' && argv[i + 1]) {
      args.startUrl = argv[i + 1];
      i += 1;
    } else if (arg === '--max-steps' && argv[i + 1]) {
      args.maxSteps = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg === '--headed') {
      args.headless = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--no-screenshot') {
      args.saveScreenshot = false;
    } else if (arg === '--help') {
      args.help = true;
    }
  }

  if (!Number.isInteger(args.maxSteps) || args.maxSteps <= 0) {
    throw new Error('--max-steps must be a positive integer.');
  }

  return args;
}

function printHelp() {
  console.log(`\nUsage: npm start -- [options]\n
Options:
  --task "..."         Goal for the AI browser agent
  --url "..."          Starting URL (default: https://www.amazon.com/)
  --max-steps N         Maximum AI steps (default: 8)
  --headed              Run browser in headed mode
  --dry-run             Print config and exit
  --no-screenshot       Skip writing automation-final.png
  --help                Show this help message\n`);
}

async function callDeepSeek(messages) {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error('Missing DEEPSEEK_API_KEY. Put it in .env or export it in your shell.');
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: 0.1,
      response_format: {
        type: 'json_object'
      }
    })
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`DeepSeek API call failed (${response.status}): ${bodyText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new Error('DeepSeek response was empty.');
  }

  return JSON.parse(text);
}

async function buildPageState(page) {
  return page.evaluate(() => {
    const text = (value) => value?.replace(/\s+/g, ' ').trim() || '';

    const inputs = Array.from(document.querySelectorAll('input,textarea')).slice(0, 12).map((el) => ({
      type: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.getAttribute('name') || null,
      placeholder: el.getAttribute('placeholder') || null,
      ariaLabel: el.getAttribute('aria-label') || null
    }));

    const buttons = Array.from(document.querySelectorAll('button,input[type="submit"],a[role="button"]')).slice(0, 12).map((el) => ({
      text: text(el.textContent) || el.getAttribute('value') || null,
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label') || null
    }));

    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 10).map((el) => ({
      text: text(el.textContent).slice(0, 80),
      href: el.getAttribute('href')
    }));

    return {
      title: document.title,
      url: window.location.href,
      inputs,
      buttons,
      links
    };
  });
}

async function getNextAction({ task, step, maxSteps, state, history }) {
  const systemPrompt = [
    'You are a web automation planner controlling Playwright.',
    'You must return strict JSON with keys: action, selector, text, url, done, reason.',
    'Allowed action values: goto, fill, click, press, wait, done.',
    'Rules:',
    '- Choose exactly one action.',
    '- Prefer robust selectors: #id, [name="..."], [aria-label="..."].',
    '- Use done=true and action="done" once the user task is achieved.',
    '- For press actions, set text to key names like Enter.',
    '- If uncertain, choose wait with reason.'
  ].join('\n');

  const userPrompt = {
    task,
    step,
    maxSteps,
    currentPage: state,
    history
  };

  const result = await callDeepSeek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: JSON.stringify(userPrompt) }
  ]);

  if (!result.action) {
    throw new Error('DeepSeek did not provide an action.');
  }

  return result;
}

async function runAction(page, actionObj) {
  const action = actionObj.action;

  if (action === 'goto') {
    if (!actionObj.url) throw new Error('goto action requires url');
    await page.goto(actionObj.url, { waitUntil: 'domcontentloaded' });
    return;
  }

  if (action === 'fill') {
    if (!actionObj.selector || typeof actionObj.text !== 'string') {
      throw new Error('fill action requires selector and text');
    }
    await page.locator(actionObj.selector).first().fill(actionObj.text);
    return;
  }

  if (action === 'click') {
    if (!actionObj.selector) throw new Error('click action requires selector');
    await page.locator(actionObj.selector).first().click();
    return;
  }

  if (action === 'press') {
    const key = actionObj.text || 'Enter';
    if (actionObj.selector) {
      await page.locator(actionObj.selector).first().press(key);
    } else {
      await page.keyboard.press(key);
    }
    return;
  }

  if (action === 'wait') {
    await page.waitForTimeout(1200);
    return;
  }

  if (action === 'done') {
    return;
  }

  throw new Error(`Unsupported action: ${action}`);
}

async function runAgent({ task, startUrl, maxSteps, headless, saveScreenshot }) {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();
  const history = [];

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

    for (let step = 1; step <= maxSteps; step += 1) {
      const state = await buildPageState(page);
      const actionObj = await getNextAction({ task, step, maxSteps, state, history });

      history.push({
        step,
        action: actionObj.action,
        selector: actionObj.selector || null,
        text: actionObj.text || null,
        reason: actionObj.reason || null
      });

      console.log(`[step ${step}]`, JSON.stringify(actionObj));

      if (actionObj.done || actionObj.action === 'done') {
        console.log('Agent marked task complete.');
        break;
      }

      try {
        await runAction(page, actionObj);
        await page.waitForLoadState('domcontentloaded');
      } catch (error) {
        history.push({ step, error: error.message });
      }
    }

    if (saveScreenshot) {
      await page.screenshot({ path: 'automation-final.png', fullPage: true });
      console.log('Saved screenshot to automation-final.png');
    }

    console.log('Final URL:', page.url());
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  console.log('AI Agent config:', JSON.stringify({
    task: args.task,
    startUrl: args.startUrl,
    maxSteps: args.maxSteps,
    headless: args.headless
  }));

  if (args.dryRun) {
    console.log('Dry run mode; no browser session launched.');
    return;
  }

  await runAgent({
    task: args.task,
    startUrl: args.startUrl,
    maxSteps: args.maxSteps,
    headless: args.headless,
    saveScreenshot: args.saveScreenshot
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
