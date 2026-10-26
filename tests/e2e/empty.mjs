// Fresh login of an account without chats: does the chat list leave the loading state?
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { readFileSync, rmSync } from 'fs';
const [user, password] = readFileSync('/test/creds.txt', 'utf8').trim().split('\n')
  .find((l) => l.startsWith(`${process.env.TUSER} `)).split(' ');
rmSync('/test/profile-empty', { recursive: true, force: true });
const context = await chromium.launchPersistentContext('/test/profile-empty', {
  executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  viewport: { width: 1280, height: 800 },
});
const page = context.pages()[0] || await context.newPage();
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log(`console.${m.type()}:`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message, e.stack?.slice(0, 400)));
await page.goto(process.env.APP_URL || 'https://tele.peyvand-yar.ir/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#matrix-username', { timeout: 30000 });
await page.fill('#matrix-username', user);
await page.fill('#matrix-password', password);
await page.click('#auth-matrix-form button[type=submit]');
await page.waitForSelector('#LeftColumn', { timeout: 30000 }).catch(async () => { console.log('NO LEFT COLUMN'); await page.screenshot({ path: '/test/empty-fail.png' }); console.log((await page.locator('body').innerText()).slice(0, 300)); });
await page.waitForTimeout(12000);
console.log('spinner in chat list:', await page.locator('#LeftColumn .chat-list .Loading, #LeftColumn .Loading').count());
console.log('empty folder shown:', await page.locator('#LeftColumn .EmptyFolder, #LeftColumn [class*="EmptyFolder"]').count());
await page.screenshot({ path: '/test/empty.png' });
await context.close();
