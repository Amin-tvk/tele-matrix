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
const title = process.env.CHAT_TITLE;
await page.locator(title ? `.ListItem.Chat:has-text("${title}")` : '.ListItem.Chat').first().click();
await page.waitForTimeout(4000);
const msg = page.locator('.Message .message-content').last();
if (process.env.MOBILE) {
  await msg.tap();
} else {
  await msg.click({ button: 'right' });
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/pk-1-menu${process.env.MOBILE ? '-m' : ''}.png` });
const more = page.locator('.ReactionSelector [class*=showMore], .ReactionSelector button').last();
console.log('selector buttons', await page.locator('.ReactionSelector button').count());
await more.click();
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/pk-2-picker${process.env.MOBILE ? '-m' : ''}.png` });
console.log(await page.evaluate(() => {
  const el = document.querySelector('.ReactionPicker, [class*=ReactionPicker]');
  return el ? `${el.className} ${el.getBoundingClientRect().width}x${el.getBoundingClientRect().height} children=${el.querySelectorAll('*').length}` : 'no picker';
}));
const tabs = page.locator('.ReactionPicker [class*=StickerSetCover], .ReactionPicker .symbol-set-button, .ReactionPicker [class*=header] button');
console.log('picker tabs', await tabs.count());
await page.evaluate(() => {
  const scroller = document.querySelector('.ReactionPicker .custom-scroll, .ReactionPicker [class*=main]');
  if (scroller) scroller.scrollTop = 1500;
});
await page.waitForTimeout(2000);
await page.screenshot({ path: `${out}/pk-3-scrolled.png` });
if (await tabs.count() > 1) {
  await tabs.nth(1).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/pk-4-tab2.png` });
}
console.log(await page.evaluate(() => [...document.querySelectorAll('.ReactionPicker *')].filter((e) => e.children.length === 0 && e.tagName !== 'IMG').slice(0, 0).length));
await context.close();
