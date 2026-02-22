import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';


function loadDotEnvIfPresent() {
  const envPath = path.resolve(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadDotEnvIfPresent();

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_TASK = 'Open Amazon and search for iPhone 17.';

function parseArgs(argv) {
  const args = {
    task: process.env.AUTOMATION_TASK || DEFAULT_TASK,
    startUrl: process.env.AUTOMATION_START_URL || 'https://www.amazon.com/',
    maxSteps: Number.parseInt(process.env.AUTOMATION_MAX_STEPS || '8', 10),
    headless: true,
    saveScreenshot: true,
    dryRun: false,
    chat: false,
    oneShot: false
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
    } else if (arg === '--chat') {
      args.chat = true;
    } else if (arg === '--one-shot') {
      args.oneShot = true;
    } else if (arg === '--help') {
      args.help = true;
    }
  }

  if (!Number.isInteger(args.maxSteps) || args.maxSteps <= 0) {
    throw new Error('--max-steps must be a positive integer.');
  }

  if (args.chat && args.oneShot) {
    throw new Error('Use either --chat or --one-shot, not both.');
  }

  if (!args.oneShot && !args.chat) {
    args.chat = true;
  }

  return args;
}

function printHelp() {
  console.log(`\nUsage: bun run start [options]\n
Options:
  --task "..."         Goal for a one-shot AI browser run
  --chat                Start interactive AI chat mode
  --one-shot            Force one-shot mode (default is chat)
  --url "..."          Starting URL (default: https://www.amazon.com/)
  --max-steps N         Maximum AI steps per goal (default: 8)
  --headed              Run browser in headed mode
  --dry-run             Print config and exit
  --no-screenshot       Skip writing automation-final.png
  --help                Show this help message\n`);
}

async function launchBrowser(headless) {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless });
}

async function callDeepSeek(messages, responseFormat = 'json') {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error('Missing DEEPSEEK_API_KEY. Put it in .env or export it in your shell.');
  }

  const body = {
    model: 'deepseek-chat',
    messages,
    temperature: 0.1
  };

  if (responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
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

  return responseFormat === 'json' ? JSON.parse(text) : text;
}

async function buildPageState(page) {
  return page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, ' ').trim() || '';

    const inputs = Array.from(document.querySelectorAll('input,textarea')).slice(0, 12).map((el) => ({
      type: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.getAttribute('name') || null,
      placeholder: el.getAttribute('placeholder') || null,
      ariaLabel: el.getAttribute('aria-label') || null
    }));

    const buttons = Array.from(document.querySelectorAll('button,input[type="submit"],a[role="button"]')).slice(0, 12).map((el) => ({
      text: normalize(el.textContent) || el.getAttribute('value') || null,
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label') || null
    }));

    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 12).map((el) => ({
      text: normalize(el.textContent).slice(0, 80),
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

async function getNextAction({ task, step, maxSteps, state, history, extractedData }) {
  const systemPrompt = [
    'You are a web automation planner controlling Playwright.',
    'Return strict JSON with keys: action, selector, text, url, done, reason.',
    'Allowed action values: goto, fill, click, press, wait, extract, done.',
    'Pick one action only, and choose robust selectors when possible.',
    'Use action=extract to capture useful text/href/url (e.g., first YouTube video link).',
    'For extract action: use selector when targeting an element, and set text to one of href|text|currentUrl.',
    'Use action=done with done=true once task is complete.'
  ].join('\n');

  const result = await callDeepSeek([
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: JSON.stringify({
        task,
        step,
        maxSteps,
        currentPage: state,
        history,
        extractedData
      })
    }
  ]);

  if (!result.action) {
    throw new Error('DeepSeek did not provide an action.');
  }

  return result;
}

async function extractFromPage(page, actionObj) {
  const mode = actionObj.text || 'text';

  if (mode === 'currentUrl') {
    return { mode, value: page.url(), selector: null };
  }

  if (!actionObj.selector) {
    throw new Error('extract action requires selector unless using text="currentUrl"');
  }

  const value = await page.locator(actionObj.selector).first().evaluate((el, selectedMode) => {
    if (selectedMode === 'href') {
      return el.getAttribute('href') || el.href || '';
    }

    return el.textContent?.trim() || '';
  }, mode);

  return {
    mode,
    selector: actionObj.selector,
    value
  };
}

async function runAction(page, actionObj) {
  if (actionObj.action === 'goto') {
    if (!actionObj.url) throw new Error('goto action requires url');
    await page.goto(actionObj.url, { waitUntil: 'domcontentloaded' });
    return null;
  }

  if (actionObj.action === 'fill') {
    if (!actionObj.selector || typeof actionObj.text !== 'string') {
      throw new Error('fill action requires selector and text');
    }
    await page.locator(actionObj.selector).first().fill(actionObj.text);
    return null;
  }

  if (actionObj.action === 'click') {
    if (!actionObj.selector) throw new Error('click action requires selector');
    await page.locator(actionObj.selector).first().click();
    return null;
  }

  if (actionObj.action === 'press') {
    const key = actionObj.text || 'Enter';
    if (actionObj.selector) {
      await page.locator(actionObj.selector).first().press(key);
    } else {
      await page.keyboard.press(key);
    }
    return null;
  }

  if (actionObj.action === 'wait') {
    await page.waitForTimeout(1200);
    return null;
  }

  if (actionObj.action === 'extract') {
    return extractFromPage(page, actionObj);
  }

  if (actionObj.action === 'done') {
    return null;
  }

  throw new Error(`Unsupported action: ${actionObj.action}`);
}

async function executeGoal(page, { task, maxSteps }) {
  const history = [];
  const extractedData = [];

  for (let step = 1; step <= maxSteps; step += 1) {
    const state = await buildPageState(page);
    const actionObj = await getNextAction({ task, step, maxSteps, state, history, extractedData });

    history.push({
      step,
      action: actionObj.action,
      selector: actionObj.selector || null,
      text: actionObj.text || null,
      reason: actionObj.reason || null
    });

    console.log(`[step ${step}]`, JSON.stringify(actionObj));

    if (actionObj.done || actionObj.action === 'done') {
      return { history, extractedData, finalState: await buildPageState(page) };
    }

    try {
      const actionResult = await runAction(page, actionObj);

      if (actionResult) {
        extractedData.push({ step, ...actionResult });
        console.log(`[extract ${step}]`, JSON.stringify(actionResult));
      }

      await page.waitForLoadState('domcontentloaded');
    } catch (error) {
      history.push({ step, error: error.message });
    }
  }

  return { history, extractedData, finalState: await buildPageState(page) };
}

async function summarizeForUser({ userGoal, finalState, history, extractedData }) {
  const prompt = [
    'You are an assistant summarizing a completed browser automation attempt.',
    'Give a short plain-English response for the end user in 2-4 bullets.',
    'If extractedData contains URLs or text answers, include them clearly.',
    'Include whether goal looks completed and what to do next if not.'
  ].join('\n');

  const content = JSON.stringify({
    userGoal,
    finalState,
    extractedData,
    recentHistory: history.slice(-6)
  });

  return callDeepSeek(
    [
      { role: 'system', content: prompt },
      { role: 'user', content }
    ],
    'text'
  );
}

async function runOneShotAgent({ task, startUrl, maxSteps, headless, saveScreenshot }) {
  const browser = await launchBrowser(headless);
  const page = await browser.newPage();

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    const { finalState, extractedData } = await executeGoal(page, { task, maxSteps });

    if (saveScreenshot) {
      await page.screenshot({ path: 'automation-final.png', fullPage: true });
      console.log('Saved screenshot to automation-final.png');
    }

    if (extractedData.length) {
      console.log('Extracted data:', JSON.stringify(extractedData, null, 2));
    }

    console.log('Final URL:', finalState.url);
  } finally {
    await browser.close();
  }
}

async function runChatAgent({ startUrl, maxSteps, headless, saveScreenshot }) {
  const browser = await launchBrowser(headless);
  const page = await browser.newPage();
  const rl = readline.createInterface({ input, output });

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    console.log('AI browser chat is ready. Type goals like:');
    console.log('  go to youtube and give me the first video url for lo-fi beats');
    console.log('Type "exit" to stop.');

    while (true) {
      const userGoal = (await rl.question('\nYou> ')).trim();

      if (!userGoal) {
        continue;
      }

      if (userGoal.toLowerCase() === 'exit') {
        break;
      }

      const { history, finalState, extractedData } = await executeGoal(page, { task: userGoal, maxSteps });
      const reply = await summarizeForUser({ userGoal, finalState, history, extractedData });
      console.log(`\nAI> ${reply}`);
      console.log(`AI> Current page: ${finalState.url}`);

      if (extractedData.length) {
        console.log(`AI> Extracted: ${JSON.stringify(extractedData)}`);
      }

      if (saveScreenshot) {
        await page.screenshot({ path: 'automation-final.png', fullPage: true });
        console.log('AI> Updated screenshot: automation-final.png');
      }
    }
  } finally {
    rl.close();
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
    mode: args.chat ? 'chat' : 'one-shot',
    task: args.task,
    startUrl: args.startUrl,
    maxSteps: args.maxSteps,
    headless: args.headless
  }));

  if (args.dryRun) {
    console.log('Dry run mode; no browser session launched.');
    return;
  }

  if (args.chat) {
    await runChatAgent({
      startUrl: args.startUrl,
      maxSteps: args.maxSteps,
      headless: args.headless,
      saveScreenshot: args.saveScreenshot
    });
    return;
  }

  await runOneShotAgent({
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
