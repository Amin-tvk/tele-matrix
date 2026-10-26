// Opens the full reaction picker on the latest message and captures what renders
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { readFileSync, mkdirSync } from 'fs';

const lines = readFileSync('/test/creds.txt', 'utf8').trim().split('\n');
const idx = Number(process.env.ACCOUNT || 0);
const [user, password] = lines[idx].split(' ');
const url = process.env.APP_URL || 'https://tele.peyvand-yar.ir/';
const out = '/test/out';
mkdirSync(out, { recursive: true });
const context = await chromium.launchPersistentContext(`/test/profile-pk${idx}`, {
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-US'],
  viewport: process.env.MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 }, locale: 'en-US',
  isMobile: Boolean(process.env.MOBILE), hasTouch: Boolean(process.env.MOBILE), colorScheme: process.env.DARK ? 'dark' : 'light',
  userAgent: process.env.MOBILE ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' : undefined,
});
const page = context.pages()[0] || await context.newPage();
page.on('console', (m) => { if (/error|warn/i.test(m.type()) && !/matrix_sdk|language/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message, e.stack?.slice(0, 500)));
page.on('requestfailed', (r) => console.log('[requestfailed]', r.url().slice(0, 150), r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url().slice(0, 150)); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#matrix-username, #LeftColumn', { timeout: 30000 });
if (await page.locator('#matrix-username').count()) {
  await page.fill('#matrix-username', user);
  await page.fill('#matrix-password', password);
  await page.click('#auth-matrix-form button[type=submit]');
}
await page.waitForSelector('.ListItem.Chat', { timeout: 60000 });
await page.waitForTimeout(3000);
const step = async (name) => { await page.waitForTimeout(1500); await page.screenshot({ path: `${out}/fd-${name}.png` }); };
await page.locator('.LeftMainHeader button').first().click();
await page.waitForTimeout(800);
await page.locator('.MenuItem:has-text("Settings")').first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/fd-0-settings.png` });
await page.locator('.ListItem:has-text("Chat Folders"), .ListItem:has-text("Folders")').first().click();
await step('1-settings');
await page.locator('button:has-text("Create New Folder")').first().click();
await step('2-new');
await page.getByRole('textbox', { name: 'Folder name' }).fill('Work');
await page.getByText('Add Chats').first().click();
await step('3-picker');
await page.getByText('Groups', { exact: true }).first().click();
await page.waitForTimeout(500);
await page.locator('#LeftColumn .FloatingActionButton:visible').last().click();
await step('4-picked');
await page.locator('#LeftColumn .FloatingActionButton:visible').last().click();
await step('5-saved');
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await step('6-list');
await page.locator('.Tab:has-text("Work")').first().click().catch(() => console.log('no Work tab'));
await step('7-work');
await context.close();
