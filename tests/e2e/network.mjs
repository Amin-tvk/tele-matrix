// Simulates a silently dropped sync connection and an offline period, timing detection and recovery
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
const context = await chromium.launchPersistentContext('/test/profile-0', {
  executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = context.pages()[0] || await context.newPage();
const t0 = Date.now();
const log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
const timeouts = new Set();
page.on('request', (r) => { if (r.url().includes('/sync?')) timeouts.add(new URL(r.url()).searchParams.get('timeout')); });
const tracked = (r) => /\/sync\?|\/versions/.test(r.url()) && t0 && TRACK.on;
const TRACK = { on: false };
const name = (r) => (r.url().includes('/sync?') ? `sync(t=${new URL(r.url()).searchParams.get('timeout')})` : 'versions');
page.on('request', (r) => { if (tracked(r)) log(`  -> ${name(r)}`); });
page.on('requestfinished', (r) => { if (tracked(r)) log(`  ok ${name(r)}`); });
page.on('requestfailed', (r) => { if (tracked(r)) log(`  FAIL ${name(r)} ${r.failure()?.errorText}`); });
await page.goto(process.env.APP_URL || 'https://tele.peyvand-yar.ir/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#LeftColumn', { timeout: 30000 });
const waiting = () => page.getByText(/Waiting for network|Connecting/).first().isVisible().catch(() => false);
async function watch(label, seconds) {
  let last;
  for (let i = 0; i < seconds * 2; i++) {
    const now = await waiting();
    if (now !== last) { log(`${label}: waiting=${now}`); last = now; }
    await page.waitForTimeout(500);
  }
}
await page.waitForTimeout(20000);
log(`sync timeouts used: ${[...timeouts].join(',')}`);

TRACK.on = true;
log('--- hanging all sync requests (silent drop)');
let hang = true;
await context.route(/\/_matrix\/client\/(v3\/sync|versions)/, async (route) => {
  if (!hang) return route.continue();
  await new Promise((r) => setTimeout(r, 120000));
  route.abort().catch(() => {});
});
await watch('hang', 45);
hang = false;
log('--- connection restored');
await watch('restore', 20);
await context.unroute(/\/_matrix\/client\/(v3\/sync|versions)/).catch(() => {});

log('--- offline');
await context.setOffline(true);
await watch('offline', 10);
await page.screenshot({ path: '/test/offline.png' });
await watch('offline', 10);
await context.setOffline(false);
log('--- online');
await watch('online', 15);
await context.close();
