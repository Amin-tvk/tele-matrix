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
  await page.addInitScript(() => {
  window.__media = new Set();
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...a) { window.__media.add(this); return orig.apply(this, a); };
});
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

const rates = () => page.evaluate(() => [...window.__media].filter((m) => !m.paused).map((m) => `${m.tagName}:${m.playbackRate}`).join(' '));
const voice = page.locator('.Message .Audio').last();
await voice.scrollIntoViewIfNeeded();
await voice.locator('.toggle-play').tap();
await page.waitForTimeout(1500);
const speedBtn = page.locator('[aria-label="Playback Speed"], [aria-label*="peed"]').first();
console.log('speed button text:', await speedBtn.innerText().catch((e) => 'none'));
for (let i = 0; i < 3; i++) {
  await speedBtn.tap();
  await page.waitForTimeout(600);
  console.log('after tap', i + 1, 'button:', await speedBtn.innerText(), 'playing:', await rates(), 'menu open:', await page.locator('.MenuItem:visible:has-text("1.5")').count());
}
await speedBtn.tap(); // to 1.5x for the round video
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/speed-voice.png` });
await voice.locator('.toggle-play').tap();
const round = page.locator('.Message .RoundVideo').last();
await round.scrollIntoViewIfNeeded();
const rb = await round.boundingBox();
await page.touchscreen.tap(rb.x + rb.width / 2, rb.y + rb.height / 2);
await page.waitForTimeout(500);
console.log('round chip:', await round.locator('.round-video-speed').innerText().catch(() => 'none'), 'playing:', await rates());
await round.locator('.round-video-speed').tap();
await page.waitForTimeout(250);
console.log('round chip after tap:', await round.locator('.round-video-speed').innerText().catch(() => 'none'), 'playing:', await rates(), 'paused?', await page.evaluate(() => [...window.__media].filter((m) => m.tagName === 'VIDEO' && !m.muted).map((m) => m.paused).join()));
await page.screenshot({ path: `${out}/speed-round.png` });
await context.close();
