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
await page.locator(`.ListItem.Chat:has-text("${process.env.CHAT_TITLE || 'Sara'}")`).first().click();
await page.waitForTimeout(5000);
await page.screenshot({ path: `${out}/voice-chat.png` });
console.log(await page.evaluate(() => [...document.querySelectorAll(".Message")].slice(-2).map((m) => m.innerHTML.slice(0, 600)).join("\n----\n")));
const voice = page.locator(".Message .Audio").last();
await voice.scrollIntoViewIfNeeded();
const state = async (label) => {
  const s = await page.evaluate(() => {
    const els0 = [...new Set([...document.querySelectorAll('audio, video'), ...(window.__media || [])])].filter((el) => el.tagName === 'AUDIO');
    const els = els0.map((el) => ({ paused: el.paused, t: el.currentTime.toFixed(2), d: el.duration, seekable: el.seekable.length ? [el.seekable.start(0), el.seekable.end(0)] : [], buffered: el.buffered.length ? [el.buffered.start(0), el.buffered.end(0)] : [], rs: el.readyState, err: el.error?.message, src: el.src }));
    const btn = document.querySelectorAll('.Message .Audio .toggle-play');
    return { els, btnClass: btn[btn.length - 1]?.className };
  });
  console.log(label, JSON.stringify(s));
};
await state('before');
await voice.locator('.toggle-play').tap();
await page.waitForTimeout(2500);
await state('after play tap');
await page.screenshot({ path: `${out}/voice-playing.png` });
await voice.locator('.toggle-play').tap();
await page.waitForTimeout(1000);
await state('after pause tap');
const src = await page.evaluate(() => [...window.__media].find((e) => e.tagName === 'AUDIO')?.src);
const r = await page.evaluate(async (u) => { const res = await fetch(u, { headers: { Range: 'bytes=100-199' } }); const b = await res.arrayBuffer(); return { status: res.status, cr: res.headers.get('content-range'), ar: res.headers.get('accept-ranges'), ct: res.headers.get('content-type'), len: b.byteLength }; }, src);
console.log('range fetch', JSON.stringify(r));
// seek: tap at 70% of the seekline
const seek = voice.locator('.waveform').first();
const box = await seek.boundingBox();
console.log('seek box', JSON.stringify(box));
if (box) {
  await voice.locator('.toggle-play').tap();
  await page.waitForTimeout(1000);
  await state('playing again');
  await page.touchscreen.tap(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.waitForTimeout(800);
  await state('after seek tap 70%');
  const cdp = await context.newCDPSession(page);
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.2, y }] });
  for (let i = 2; i <= 9; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * i / 10, y }] });
    await page.waitForTimeout(50);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(800);
  await state('after drag to 90%');
}
await page.screenshot({ path: `${out}/voice-after.png` });
await context.close();
