// Fresh device login timeline: page load, login, first chat list, first chat opened
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { readFileSync, rmSync } from 'fs';
const [user, password] = readFileSync('/test/creds.txt', 'utf8').trim().split('\n')
  .find((l) => l.startsWith(`${process.env.TUSER || 'teletest1'} `)).split(' ');
rmSync('/test/profile-cold', { recursive: true, force: true });
const context = await chromium.launchPersistentContext('/test/profile-cold', {
  executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  viewport: { width: 1280, height: 800 },
});
const page = context.pages()[0] || await context.newPage();
if (process.env.SLOW) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  // Typical mobile 4G in practice: ~4 Mbps down, 150 ms RTT; mid-range phone CPU
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 4e6 / 8, uploadThroughput: 1e6 / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}
const t0 = Date.now();
const log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(2)}s ${m}`);
const reqs = [];
let bytes = 0;
page.on('requestfinished', async (r) => {
  const t = r.timing();
  const size = (await r.sizes().catch(() => ({ responseBodySize: 0 }))).responseBodySize;
  bytes += size;
  const u = new URL(r.url());
  reqs.push({ at: (Date.now() - t0) / 1000, dur: t.responseEnd, size, path: `${u.host}${u.pathname}${u.search.slice(0, 40)}` });
});
await page.goto(process.env.APP_URL || 'https://tele.peyvand-yar.ir/', { waitUntil: 'domcontentloaded' });
log('domcontentloaded');
await page.waitForSelector('#matrix-username', { timeout: 60000 });
log(`login form visible (${(bytes / 1024).toFixed(0)} KB so far)`);
await page.waitForTimeout(Number(process.env.TYPE_DELAY || 0));
await page.fill('#matrix-username', user);
await page.fill('#matrix-password', password);
const tLogin = Date.now();
await page.click('#auth-matrix-form button[type=submit]');
await page.waitForSelector('#LeftColumn', { timeout: 120000 });
log('main UI shown');
page.waitForSelector('.ListItem.Chat .Avatar img', { timeout: 120000 }).then(() => log('first avatar image')).catch(() => {});
await page.waitForSelector('.ListItem.Chat', { timeout: 120000 });
log(`first chat in list (${((Date.now() - tLogin) / 1000).toFixed(2)}s after submit)`);
await page.locator('.ListItem.Chat').first().click();
const tOpen = Date.now();
await page.waitForSelector('.Message', { timeout: 60000 }).catch(() => log('no messages appeared'));
log(`first chat messages shown (${((Date.now() - tOpen) / 1000).toFixed(2)}s after click)`);
await page.waitForTimeout(3000);
console.log(`TOTAL ${(bytes / 1024 / 1024).toFixed(2)} MB in ${reqs.length} requests`);
console.log('--- slowest requests');
reqs.sort((a, b) => b.dur - a.dur).slice(0, 15).forEach((r) => console.log(`${r.at.toFixed(1)}s ${r.dur.toFixed(0)}ms ${(r.size / 1024).toFixed(0)}KB ${r.path}`));
console.log('--- largest');
reqs.sort((a, b) => b.size - a.size).slice(0, 10).forEach((r) => console.log(`${(r.size / 1024).toFixed(0)}KB ${r.path}`));
await context.close();
