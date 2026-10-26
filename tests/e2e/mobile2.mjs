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

const login = async () => {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#matrix-username, #LeftColumn', { timeout: 30000 });
  if (await page.locator('#matrix-username').count()) {
    await page.fill('#matrix-username', user);
    await page.fill('#matrix-password', password);
    await page.click('#auth-matrix-form button[type=submit]');
  }
  await page.waitForSelector('.ListItem.Chat', { timeout: 60000 });
};
await login(); await page.waitForTimeout(3000); await login(); // second load gets the new bundle
await page.waitForTimeout(3000);
await page.locator('.ListItem.Chat:has-text("Sara")').first().click();
await page.waitForTimeout(4000);
const step = process.env.STEP || 'all';

if (step === 'all' || step === 'todo') {
  await page.locator('.AttachMenu--button').first().tap();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/attach-menu.png` });
  await page.locator('.MenuItem:not(.disabled):has-text("Checklist")').first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/todo-open.png` });
  console.log('inputs', await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.className + '|' + i.placeholder).join(' ; ')));
  await page.keyboard.type('Shopping ' + Date.now() % 1000);
  const task = page.locator('input[placeholder="Add a task"]').first();
  await task.click();
  await page.keyboard.type('Milk'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  await page.keyboard.type('Bread');
  await page.screenshot({ path: `${out}/todo-modal.png` });
  await page.locator('button:has-text("Create")').first().click();
  await page.waitForTimeout(4000);
  const todo = page.locator('.Message .todo-list').last();
  console.log('todo items', await todo.locator('.todo-list-items').innerText().catch((e) => 'none ' + e.message.slice(0, 80)));
  await page.screenshot({ path: `${out}/todo-sent.png` });
  const itemBox = await todo.locator('.todo-list-items > *').first().boundingBox();
  await page.touchscreen.tap(itemBox.x + 30, itemBox.y + itemBox.height / 2);
  await page.waitForTimeout(3000);
  console.log('completed', await todo.locator('.completed-tasks-count').innerText().catch(() => '?'), 'reactions on todo:', await todo.locator('xpath=ancestor::div[contains(@class,"Message")][1]').locator('.Reactions').count());
  await page.screenshot({ path: `${out}/todo-checked.png` });
}

if (step === 'all' || step === 'react') {
  const msg = page.locator('.Message:has(.text-content)').last();
  const box = await msg.locator('.text-content').boundingBox();
  await page.touchscreen.tap(box.x + 20, box.y + 10);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(box.x + 20, box.y + 10);
  await page.waitForTimeout(2500);
  console.log('reactions on last text msg:', await msg.locator('.Reactions, .message-reaction, [class*=eaction]').count());
  await page.screenshot({ path: `${out}/quickreact.png` });
}

if (step === 'all' || step === 'swipe') {
  const cdp = await context.newCDPSession(page);
  const y = 400;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 60, y }] });
  for (let x = 70; x <= 330; x += 20) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
    if (x === 190) console.log('anim level', await page.evaluate(() => document.body.className)), await page.screenshot({ path: `${out}/swipe-mid.png` });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(1200);
  console.log('main classes after swipe:', await page.locator('#Main').getAttribute('class'));
  await page.screenshot({ path: `${out}/swipe-done.png` });
}
await context.close();
