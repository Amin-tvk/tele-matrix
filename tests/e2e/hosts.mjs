// Records every host the app contacts during load and a minute of idle use
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
const context = await chromium.launchPersistentContext('/test/profile-0', {
  executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const hosts = new Map();
const failed = [];
context.on('request', (r) => { const h = new URL(r.url()).host || r.url().slice(0, 20); hosts.set(h, (hosts.get(h) || 0) + 1); });
context.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`));
const page = context.pages()[0] || await context.newPage();
await page.goto(process.env.APP_URL || 'https://tele.peyvand-yar.ir/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#LeftColumn', { timeout: 30000 });
await page.locator('.ListItem.Chat').first().click().catch(() => {});
await page.waitForTimeout(60000);
console.log(JSON.stringify([...hosts], null, 1));
console.log('FAILED', failed.join('\n'));
await context.close();
