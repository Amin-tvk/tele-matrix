// Logs a test account into the preview build and captures screenshots and console output
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { readFileSync, mkdirSync } from 'fs';

const [user, password] = readFileSync('/test/creds.txt', 'utf8').trim().split('\n')[Number(process.env.ACCOUNT || 0)].split(' ');
const url = process.env.APP_URL || 'http://127.0.0.1:18090/';
const out = '/test/out';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}\n${err.stack}`));
page.on('requestfailed', (req) => logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));
page.on('response', (res) => {
  if (res.status() >= 400) logs.push(`[http ${res.status()}] ${res.url()}`);
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/01-auth.png` });

await page.fill('#matrix-username', user);
await page.fill('#matrix-password', password);
await page.click('#auth-matrix-form button[type=submit]');
await page.waitForTimeout(Number(process.env.WAIT || 12000));
await page.screenshot({ path: `${out}/02-after-login.png` });

console.log(logs.join('\n'));
await browser.close();
