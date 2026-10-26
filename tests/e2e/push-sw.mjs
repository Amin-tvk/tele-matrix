// Delivers a Sygnal-format push to the app's service worker through CDP and reads the shown notifications
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { readFileSync } from 'fs';

const url = process.env.APP_URL || 'http://127.0.0.1:18091/';
const context = await chromium.launchPersistentContext('/test/profile-0', {
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  permissions: ['notifications'],
  viewport: { width: 1280, height: 800 },
});
const page = context.pages()[0] || await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#LeftColumn', { timeout: 30000 });
await page.waitForTimeout(3000);

const other = await context.newPage();
await other.goto('about:blank');
const cdp = await context.newCDPSession(other);
const registrations = [];
cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations: list }) => registrations.push(...list));
await cdp.send('ServiceWorker.enable');
await page.waitForTimeout(1000);
const registration = registrations.find((r) => !r.isDeleted);
console.log('registration', registration?.registrationId, registration?.scopeURL);

// Close the app so the push arrives the way it does when the browser tab is closed
await page.close();

const swEarly = context.serviceWorkers()[0];
try {
  const swCdp = await context.newCDPSession(swEarly);
  await swCdp.send('Runtime.enable');
  swCdp.on('Runtime.exceptionThrown', (e) => console.log('SW EXC', JSON.stringify(e.exceptionDetails).slice(0, 600)));
  swCdp.on('Runtime.consoleAPICalled', (e) => console.log('SW LOG', e.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300)));
} catch (err) { console.log('no sw cdp', err.message); }
await swEarly.evaluate(() => {
  self.swErrors = [];
  const original = self.registration.showNotification.bind(self.registration);
  self.registration.showNotification = (title, options) => {
    self.swErrors.push(`show called: ${title}`);
    return original(title, options).catch((err) => { self.swErrors.push(`show failed: ${err}`); throw err; });
  };
  self.addEventListener('error', (e) => self.swErrors.push(`error ${e.message}`));
  self.addEventListener('unhandledrejection', (e) => self.swErrors.push(`rejection ${e.reason}`));
  const origWait = ExtendableEvent.prototype.waitUntil;
  ExtendableEvent.prototype.waitUntil = function (promise) {
    promise.catch((err) => self.swErrors.push(`waitUntil rejected: ${err && err.stack}`));
    return origWait.call(this, promise);
  };
  self.addEventListener('push', (e) => {
    self.gotPush = (self.gotPush || 0) + 1;
    try { self.lastPushData = e.data && e.data.text(); } catch (err) { self.lastPushData = String(err); }
  });
});
const dmRoom = readFileSync('/test/dm_room', 'utf8').trim();
const groupRoom = readFileSync('/test/group_room', 'utf8').trim();
const pushes = [
  {
    event_id: '$test1', room_id: dmRoom, sender: '@teletest2:mtx.peyvand-yar.ir', sender_display_name: 'Sara Test',
    type: 'm.room.message', content: { msgtype: 'm.text', body: 'Hello from push!' }, prio: 'high', unread: 1,
  },
  {
    event_id: '$test2', room_id: groupRoom, room_name: 'Team', sender: '@teletest2:mtx.peyvand-yar.ir',
    sender_display_name: 'Sara Test', type: 'm.room.message', content: { msgtype: 'm.image', body: 'a.png' },
    prio: 'high', unread: 2,
  },
];
for (const data of pushes) {
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: new URL(url).origin,
    registrationId: registration.registrationId,
    data: JSON.stringify(data),
  });
  await other.waitForTimeout(1500);
}

const sw = context.serviceWorkers()[0];
console.log('SW', sw?.url());
if (sw) {
  console.log('SW notifications', await sw.evaluate(async () => (await self.registration.getNotifications()).map((n) => `${n.title} | ${n.body} | ${n.tag} | ${JSON.stringify(n.data)}`)));
  console.log('SW errors', await sw.evaluate(() => self.swErrors.join('\n')));
  console.log('SW got push', await sw.evaluate(() => `${self.gotPush} ${self.lastPushData}`));
  console.log('SW clients', await sw.evaluate(async () => (await self.clients.matchAll({ type: 'window' })).map((c) => `${c.url} ${c.visibilityState} ${c.focused}`)));
}
const { result } = await cdp.send('Runtime.evaluate', { expression: '1' });
void result;
const checker = await context.newPage();
await checker.goto(`${url}compatTest.js`);
const shown = await checker.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const list = reg ? await reg.getNotifications() : [];
  return list.map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }));
});
console.log(JSON.stringify(shown, undefined, 1));
await context.close();
