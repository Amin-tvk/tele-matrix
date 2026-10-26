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
await page.locator(`.ListItem.Chat:has-text("${process.env.CHAT_TITLE}")`).first().click();
await page.waitForTimeout(4000);
// Seen-by on my last own message
const own = page.locator('.Message.own .message-content').last();
await own.click({ button: 'right' });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/tg-1-own-menu.png` });
const seen = page.locator('.MessageContextMenu .MenuItem').last();
console.log('seen item', await seen.count(), await seen.first().textContent().catch(() => ''));
if (await seen.count()) {
  await seen.first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${out}/tg-2-seen-list.png` });
}
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
await page.locator(`.ListItem.Chat:has-text("${process.env.CHAT_TITLE}")`).first().click();
await page.waitForTimeout(2000);
// Tag via profile members
await page.locator('.modal-dialog button:has-text("Close")').click().catch(() => undefined);
await page.waitForTimeout(800);
console.log(await page.evaluate(() => { const el = document.elementFromPoint(600, 40); return el ? [el.className, el.parentElement?.className, el.parentElement?.parentElement?.className].join(' | ') : 'none'; }));
await page.mouse.click(620, 32);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/tg-3a-profile.png` });
const member = page.locator('#RightColumn .ListItem:has-text("Sara")').first();
await member.click({ button: 'right' });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${out}/tg-3-member-menu.png` });
await page.locator('.MenuItem:has-text("Edit Tag")').first().click();
await page.waitForTimeout(1000);
await page.fill('#edit-rank', process.env.TAG || 'Designer');
await page.screenshot({ path: `${out}/tg-4-edit.png` });
await page.keyboard.press('Enter');
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/tg-5-after.png` });
await context.close();
