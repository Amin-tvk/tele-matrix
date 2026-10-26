// Read receipts in both directions between the UI (teletest1) and teletest2 through the API
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { readFileSync, mkdirSync } from 'fs';

const HS = process.env.MATRIX_URL || 'https://mtx.peyvand-yar.ir';
const url = process.env.APP_URL || 'https://tele.peyvand-yar.ir/';
const tok2 = readFileSync('/test/tok2', 'utf8').trim();
const dmRoom = readFileSync('/test/dm_room', 'utf8').trim();
const out = '/test/out';
mkdirSync(out, { recursive: true });
const api = async (method, path, body) => {
  const res = await fetch(`${HS}/_matrix/client/v3${path}`, {
    method, headers: { Authorization: `Bearer ${tok2}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};
const receiptsOf = async () => {
  const res = await api('GET', `/rooms/${encodeURIComponent(dmRoom)}/messages?dir=b&limit=1`);
  void res;
  const sync = await api('GET', `/sync?filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [dmRoom], timeline: { limit: 0 }, state: { lazy_load_members: true } }, presence: { not_types: ['*'] }, account_data: { not_types: ['*'] } }))}`);
  const eph = sync.rooms?.join?.[dmRoom]?.ephemeral?.events || [];
  return eph.filter((e) => e.type === 'm.receipt').map((e) => JSON.stringify(e.content)).join(' ');
};

const context = await chromium.launchPersistentContext('/test/profile-0', {
  executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-US'],
  viewport: { width: 1280, height: 800 }, locale: 'en-US',
});
const page = context.pages()[0] || await context.newPage();
page.on('request', (r) => { if (/read_markers|receipt/.test(r.url())) console.log('[req]', r.method(), r.url().slice(-120)); });
page.on('console', (msg) => { if (/ui-readstate|receipt-trace|sendMessage|read_markers|receipt|\[matrix\]/i.test(msg.text()) && !/FetchHttpApi|Error decrypting/.test(msg.text())) console.log('[console]', msg.text().slice(0, 200)); });
let n = 0;
const snap = (name) => page.screenshot({ path: `${out}/r${++n}-${name}.png` });
await page.goto(url);
await page.waitForSelector('#LeftColumn', { timeout: 30000 });
await page.waitForTimeout(6000);

// Incoming messages while the chat is closed
for (let i = 1; i <= 3; i++) {
  await api('PUT', `/rooms/${encodeURIComponent(dmRoom)}/send/m.room.message/r${Date.now()}${i}`, { msgtype: 'm.text', body: `Unread test ${i}` });
}
await page.waitForTimeout(4000);
await snap('list-unread');
console.log('receipts before open', await receiptsOf());

await page.locator('.ListItem.Chat:has-text("Sara Test")').first().click();
await page.waitForTimeout(5000);
await snap('opened');
console.log('receipts after open', await receiptsOf());

// Outgoing message, then the other side reads it
await page.locator('#editable-message-text').click();
await page.keyboard.type(`Outgoing ${Date.now()}`);
await page.keyboard.press('Enter');
await page.waitForTimeout(4000);
await snap('sent');
const last = await api('GET', `/rooms/${encodeURIComponent(dmRoom)}/messages?dir=b&limit=1`);
const lastId = last.chunk[0].event_id;
console.log('last event', last.chunk[0].sender, lastId);
await api('POST', `/rooms/${encodeURIComponent(dmRoom)}/receipt/m.read/${encodeURIComponent(lastId)}`, {});
await page.waitForTimeout(5000);
await snap('read-by-other');
const ticks = await page.evaluate(() => [...document.querySelectorAll('.Message.own')].slice(-3).map((m) => `${m.getAttribute('data-message-id')} ${m.id} ${m.querySelector('.MessageOutgoingStatus i, .MessageOutgoingStatus .icon')?.className}`));
console.log('own ticks', JSON.stringify(ticks));
await page.locator('#LeftColumn').screenshot({ path: `${out}/r${++n}-list-after.png` });
await context.close();
