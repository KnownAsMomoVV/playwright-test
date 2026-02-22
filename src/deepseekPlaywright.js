import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

function loadDotEnvIfPresent() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

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
    maxSteps: Number.parseInt(process.env.AUTOMATION_MAX_STEPS || '12', 10),
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

  if (args.chat && args.oneShot) throw new Error('Use either --chat or --one-shot, not both.');
  if (!args.oneShot && !args.chat) args.chat = true;
  return args;
}

function printHelp() {
  console.log(`\nUsage: bun run start [options]\n
Options:
  --task "..."         Goal for a one-shot AI browser run
  --chat                Start interactive AI chat mode
  --one-shot            Force one-shot mode (default is chat)
  --url "..."          Starting URL (default: https://www.amazon.com/)
  --max-steps N         Maximum AI steps per goal (default: 12)
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
  if (!apiKey) throw new Error('Missing DEEPSEEK_API_KEY. Put it in .env or export it in your shell.');

  const body = { model: 'deepseek-chat', messages, temperature: 0.1 };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`DeepSeek API call failed (${response.status}): ${bodyText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('DeepSeek response was empty.');
  return responseFormat === 'json' ? JSON.parse(text) : text;
}


async function tryHandleCookieConsent(page) {
  const candidates = [
    () => page.getByRole('button', { name: /accept all|i agree|agree to all|allow all|accept cookies/i }).first(),
    () => page.locator('button:has-text("Accept all")').first(),
    () => page.locator('button:has-text("I agree")').first(),
    () => page.locator('form [type="submit"]:has-text("Accept")').first(),
    () => page.locator('[aria-label*="Accept" i]').first()
  ];

  for (const getLocator of candidates) {
    const locator = getLocator();
    if (await locator.count()) {
      await locator.click({ timeout: 2000 });
      await page.waitForTimeout(800);
      return true;
    }
  }

  return false;
}

async function rewriteGoal(userGoal) {
  const result = await callDeepSeek([
    {
      role: 'system',
      content: 'Rewrite user request into a precise browser objective. Return JSON: {objective, mustDo, mustExtract, doneCriteria}.'
    },
    { role: 'user', content: userGoal }
  ]);

  return {
    objective: result.objective || userGoal,
    mustDo: Array.isArray(result.mustDo) ? result.mustDo : [],
    mustExtract: Array.isArray(result.mustExtract) ? result.mustExtract : [],
    doneCriteria: Array.isArray(result.doneCriteria) ? result.doneCriteria : []
  };
}

async function buildPageState(page) {
  return page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, ' ').trim() || '';
    const inputs = Array.from(document.querySelectorAll('input,textarea')).slice(0, 14).map((el) => ({
      type: el.tagName.toLowerCase(), id: el.id || null, name: el.getAttribute('name') || null,
      placeholder: el.getAttribute('placeholder') || null, ariaLabel: el.getAttribute('aria-label') || null
    }));
    const buttons = Array.from(document.querySelectorAll('button,input[type="submit"],a[role="button"]')).slice(0, 14).map((el) => ({
      text: normalize(el.textContent) || el.getAttribute('value') || null, id: el.id || null, ariaLabel: el.getAttribute('aria-label') || null
    }));
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 16).map((el) => ({
      text: normalize(el.textContent).slice(0, 100), href: el.getAttribute('href')
    }));
    return { title: document.title, url: window.location.href, inputs, buttons, links };
  });
}

async function getNextAction({ goalSpec, step, maxSteps, state, history, extractedData }) {
  const systemPrompt = [
    'You are a robust web automation planner for Playwright.',
    'Return strict JSON: {action, selector, text, url, done, reason}.',
    'Allowed actions: goto, fill, click, press, wait, extract, done.',
    'Critical behavior: if an input is filled but search not submitted, next step should click submit or press Enter.',
    'Avoid vague queries; use exact subject names from objective.',
    'Do not mark done until doneCriteria are satisfied and mustExtract items are captured when possible.',
    'For extract use text as href|text|currentUrl and provide selector unless currentUrl.'
  ].join('\n');

  const result = await callDeepSeek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: JSON.stringify({ goalSpec, step, maxSteps, currentPage: state, history, extractedData }) }
  ]);

  if (!result.action) throw new Error('DeepSeek did not provide an action.');
  return result;
}

async function extractFromPage(page, actionObj) {
  const mode = actionObj.text || 'text';
  if (mode === 'currentUrl') return { mode, value: page.url(), selector: null };
  if (!actionObj.selector) throw new Error('extract action requires selector unless using text="currentUrl"');

  const value = await page.locator(actionObj.selector).first().evaluate((el, selectedMode) => {
    if (selectedMode === 'href') return el.getAttribute('href') || el.href || '';
    return el.textContent?.trim() || '';
  }, mode);

  return { mode, selector: actionObj.selector, value };
}

async function runAction(page, actionObj) {
  if (actionObj.action === 'goto') {
    if (!actionObj.url) throw new Error('goto action requires url');
    await page.goto(actionObj.url, { waitUntil: 'domcontentloaded' });
    return null;
  }
  if (actionObj.action === 'fill') {
    if (!actionObj.selector || typeof actionObj.text !== 'string') throw new Error('fill action requires selector and text');
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
    if (actionObj.selector) await page.locator(actionObj.selector).first().press(key);
    else await page.keyboard.press(key);
    return null;
  }
  if (actionObj.action === 'wait') {
    await page.waitForTimeout(1200);
    return null;
  }
  if (actionObj.action === 'extract') return extractFromPage(page, actionObj);
  if (actionObj.action === 'done') return null;
  throw new Error(`Unsupported action: ${actionObj.action}`);
}

async function verifyGoalCompletion({ goalSpec, finalState, extractedData }) {
  const verdict = await callDeepSeek([
    {
      role: 'system',
      content: 'You are a strict verifier. Return JSON {completed:boolean, explanation:string, missing:string[]} based on goalSpec, finalState, extractedData.'
    },
    { role: 'user', content: JSON.stringify({ goalSpec, finalState, extractedData }) }
  ]);

  return {
    completed: Boolean(verdict.completed),
    explanation: verdict.explanation || '',
    missing: Array.isArray(verdict.missing) ? verdict.missing : []
  };
}

async function executeGoal(page, { task, maxSteps }) {
  const history = [];
  const extractedData = [];
  const goalSpec = await rewriteGoal(task);
  const wantsCookieConsent = /cookie|consent/i.test(task);

  console.log('[goal]', JSON.stringify(goalSpec));

  for (let step = 1; step <= maxSteps; step += 1) {
    if (wantsCookieConsent) {
      const handled = await tryHandleCookieConsent(page);
      if (handled) {
        history.push({ step, action: 'heuristic-cookie-click', reason: 'Clicked visible consent button before planner step.' });
      }
    }
    const state = await buildPageState(page);
    const actionObj = await getNextAction({ goalSpec, step, maxSteps, state, history, extractedData });

    history.push({ step, action: actionObj.action, selector: actionObj.selector || null, text: actionObj.text || null, reason: actionObj.reason || null });
    console.log(`[step ${step}]`, JSON.stringify(actionObj));

    if (actionObj.done || actionObj.action === 'done') break;

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

  const finalState = await buildPageState(page);
  const verification = await verifyGoalCompletion({ goalSpec, finalState, extractedData });

  return { history, extractedData, finalState, goalSpec, verification };
}

async function summarizeForUser({ userGoal, goalSpec, finalState, history, extractedData, verification }) {
  const prompt = [
    'You are an assistant summarizing a browser automation result for end users.',
    'Use 2-5 bullets. Include extracted links/text clearly.',
    'Explicitly say if completed or not using verifier result, and suggest one next prompt if incomplete.'
  ].join('\n');

  const content = JSON.stringify({ userGoal, goalSpec, finalState, extractedData, verification, recentHistory: history.slice(-8) });
  return callDeepSeek([{ role: 'system', content: prompt }, { role: 'user', content }], 'text');
}

async function runOneShotAgent({ task, startUrl, maxSteps, headless, saveScreenshot }) {
  const browser = await launchBrowser(headless);
  const page = await browser.newPage();
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    const result = await executeGoal(page, { task, maxSteps });

    if (saveScreenshot) {
      const shotPath = result.verification.completed ? 'automation-final.png' : 'automation-partial.png';
      await page.screenshot({ path: shotPath, fullPage: true });
      console.log(`Saved screenshot to ${shotPath}`);
    }

    if (result.extractedData.length) {
      console.log('Extracted data:', JSON.stringify(result.extractedData, null, 2));
    }

    console.log('Verification:', JSON.stringify(result.verification));
    console.log('Final URL:', result.finalState.url);
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
    console.log('  go to youtube, find the newest cdawgva video, open it, and screenshot it');
    console.log('Type "exit" to stop.');

    while (true) {
      const userGoal = (await rl.question('\nYou> ')).trim();
      if (!userGoal) continue;
      if (userGoal.toLowerCase() === 'exit') break;

      const result = await executeGoal(page, { task: userGoal, maxSteps });
      const reply = await summarizeForUser({ userGoal, ...result });

      console.log(`\nAI> ${reply}`);
      console.log(`AI> Current page: ${result.finalState.url}`);
      console.log(`AI> Verification: ${result.verification.completed ? 'completed' : 'not completed'} - ${result.verification.explanation}`);

      if (result.extractedData.length) {
        console.log(`AI> Extracted: ${JSON.stringify(result.extractedData)}`);
      }

      if (saveScreenshot) {
        const shotPath = result.verification.completed ? 'automation-final.png' : 'automation-partial.png';
        await page.screenshot({ path: shotPath, fullPage: true });
        console.log(`AI> Updated screenshot: ${shotPath}`);
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

  console.log('AI Agent config:', JSON.stringify({ mode: args.chat ? 'chat' : 'one-shot', task: args.task, startUrl: args.startUrl, maxSteps: args.maxSteps, headless: args.headless }));

  if (args.dryRun) {
    console.log('Dry run mode; no browser session launched.');
    return;
  }

  if (args.chat) {
    await runChatAgent({ startUrl: args.startUrl, maxSteps: args.maxSteps, headless: args.headless, saveScreenshot: args.saveScreenshot });
    return;
  }

  await runOneShotAgent({ task: args.task, startUrl: args.startUrl, maxSteps: args.maxSteps, headless: args.headless, saveScreenshot: args.saveScreenshot });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
