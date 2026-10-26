// End-to-end walk-through of the Matrix-backed Telegram UI with screenshots
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { readFileSync, mkdirSync } from 'fs';

const lines = readFileSync('/test/creds.txt', 'utf8').trim().split('\n');
const [user, password] = lines[Number(process.env.CRED_INDEX ?? process.env.ACCOUNT ?? 0)].split(' ');
const url = process.env.APP_URL || 'http://127.0.0.1:18091/';
const out = '/test/out';
const steps = (process.env.STEPS || 'login,list,open,send').split(',');
const filter = process.env.LOG_FILTER ? new RegExp(process.env.LOG_FILTER, 'i') : undefined;
mkdirSync(out, { recursive: true });

const context = await chromium.launchPersistentContext(`/test/profile-${process.env.ACCOUNT || 0}`, {
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-US',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  permissions: ['microphone', 'camera', 'notifications'],
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
});
const page = context.pages()[0] || await context.newPage();
const browser = context;
const logs = [];
const NOISE = /matrix_sdk|at \/home\/runner|row_count|request_id|removed_fallback|GL Driver|Unexpected mutation|language detector/;
const push = (line) => {
  if (NOISE.test(line)) return;
  if (filter && !filter.test(line)) return;
  logs.push(line);
};
page.on('console', (msg) => push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => push(`[pageerror] ${err.message}\n${err.stack}`));
page.on('requestfailed', (req) => push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));
page.on('response', (res) => {
  if (res.status() >= 400) push(`[http ${res.status()}] ${res.url()}`);
});

let shot = 0;
const snap = async (name) => {
  shot++;
  await page.screenshot({ path: `${out}/${String(shot).padStart(2, '0')}-${name}.png` });
};

await page.addInitScript(() => {
  const original = console.error;
  console.error = (...args) => original(...args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : a)));
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#matrix-username, #LeftColumn', { timeout: 30000 }).catch(() => undefined);
await page.waitForTimeout(1500);

if (steps.includes('forget')) {
  // Drops the saved session but keeps IndexedDB, like a logout that left the old crypto store behind
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#matrix-username', { timeout: 30000 });
}

if (steps.includes('login') && await page.locator('#matrix-username').count()) {
  await page.fill('#matrix-username', user);
  await page.fill('#matrix-password', password);
  await snap('auth');
  await page.click('#auth-matrix-form button[type=submit]');
  await page.waitForTimeout(10000);
}

if (steps.includes('list')) {
  await snap('list');
}

if (steps.includes('open')) {
  const chatSelector = process.env.CHAT_TITLE
    ? `.ListItem.Chat:has-text("${process.env.CHAT_TITLE}")`
    : '.ListItem.Chat';
  await page.locator(chatSelector).first().click();
  await page.waitForTimeout(4000);
  await snap('open');
}

if (steps.includes('send')) {
  const text = process.env.MESSAGE || `Test from Telegram UI ${new Date().toISOString().slice(11, 19)}`;
  await page.locator('#editable-message-text').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  await snap('sent');
}

const HS = process.env.MATRIX_URL || 'https://mtx.peyvand-yar.ir';
const otherToken = readFileSync(`/test/tok${process.env.ACCOUNT === '1' ? 1 : 2}`, 'utf8').trim();
const groupRoom = readFileSync('/test/group_room', 'utf8').trim();
const dmRoom = readFileSync('/test/dm_room', 'utf8').trim();

async function sendAsOther(roomId, content) {
  const txn = `e2e${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${otherToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(content),
  });
  return res.json();
}

async function openContextMenuOnLastMessage(isOwn) {
  const selector = isOwn ? '.Message.own' : '.Message:not(.own)';
  const message = page.locator(`${selector} .message-content`).last();
  await message.click({ button: 'right' });
  await page.waitForTimeout(800);
}

async function clickMenuItem(text) {
  await page.locator(`.MenuItem:has-text("${text}")`).first().click();
  await page.waitForTimeout(800);
}

if (steps.includes('incoming')) {
  await sendAsOther(process.env.INCOMING_ROOM === 'dm' ? dmRoom : groupRoom, {
    msgtype: 'm.text', body: `Live message from the other side ${new Date().toISOString().slice(11, 19)}`,
  });
  await page.waitForTimeout(4000);
  await snap('incoming');
}

if (steps.includes('notif')) {
  const otherTab = await context.newPage();
  await otherTab.goto('about:blank');
  await otherTab.bringToFront();
  await page.evaluate(() => { document.hasFocus = () => false; });
  console.log('FOCUS', await page.evaluate(() => document.hasFocus()));
  await sendAsOther(dmRoom, { msgtype: 'm.text', body: `Notification test ${Date.now()}` });
  await page.waitForTimeout(5000);
  console.log('NOTIFS', await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return JSON.stringify((await reg.getNotifications()).map((n) => `${n.title} | ${n.body} | ${n.tag}`));
  }));
}

if (steps.includes('typing')) {
  await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(process.env.INCOMING_ROOM === 'dm' ? dmRoom : groupRoom)}/typing/${encodeURIComponent(process.env.OTHER_USER)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${otherToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ typing: true, timeout: 10000 }),
  });
  await page.waitForTimeout(2500);
  await snap('typing');
}

if (steps.includes('reply')) {
  await openContextMenuOnLastMessage(false);
  await clickMenuItem('Reply');
  await page.locator('#editable-message-text').click();
  await page.keyboard.type('This is a reply');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  await snap('reply');
}

if (steps.includes('state')) {
  if (process.env.STATE_TITLE) await page.evaluate((t) => { window.STATE_TITLE = t; }, process.env.STATE_TITLE);
  console.log('STATE', await page.evaluate(() => {
    const g = window.getGlobal();
    const chatId = Object.keys(g.chats.byId).find((id) => (window.STATE_TITLE
      ? g.chats.byId[id].title === window.STATE_TITLE : id.startsWith('-')));
    const tab = Object.values(g.byTabId)[0];
    return JSON.stringify({
      sync: { isSyncing: g.isSyncing, isSynced: g.isSynced, diff: g.isFetchingDifference, conn: g.connectionState, lang: g.sharedState?.settings?.language },
      chat: g.chats.byId[chatId],
      fullInfo: g.chats.fullInfoById[chatId],
      availableReactions: g.reactions.availableReactions?.length,
      thread: g.messages.byChatId[chatId]?.threadsById?.['-1'] && {
        listed: g.messages.byChatId[chatId].threadsById['-1'].localState?.listedIds,
        viewport: tab && tab.tabThreads?.[chatId]?.['-1']?.viewportIds,
        readState: g.messages.byChatId[chatId].threadsById['-1'].readState,
        info: g.messages.byChatId[chatId].threadsById['-1'].threadInfo,
      },
      lastMessageId: g.chats.lastMessageIds?.all?.[chatId],
      messages: Object.values(g.messages.byChatId[chatId]?.byId || {}).map((m) => `${m.id}:${m.content.text?.text || m.content.action?.type || (m.content.photo ? 'photo' : Object.keys(m.content).join('+'))}`),
    }).slice(0, 3000);
  }));
}

if (steps.includes('react')) {
  await openContextMenuOnLastMessage(false);
  await snap('context-menu');
  console.log('REACTION DEBUG', await page.evaluate(() => {
    const selector = document.querySelector('.ReactionSelector');
    return selector ? `selector items=${selector.querySelectorAll('img').length} html=${selector.outerHTML.slice(0, 300)}` : 'no selector';
  }));
  const reaction = page.locator('.ReactionSelector [class*=ReactionSelectorReaction-module__root]').nth(Number(process.env.REACTION_INDEX || 0));
  if (await reaction.count()) {
    await reaction.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(3000);
  await snap('react');
}

if (steps.includes('edit')) {
  await openContextMenuOnLastMessage(true);
  await clickMenuItem('Edit');
  await page.keyboard.press('End');
  await page.keyboard.type(' (edited)');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  await snap('edit');
}

if (steps.includes('delete')) {
  await openContextMenuOnLastMessage(true);
  await clickMenuItem('Delete');
  await page.waitForTimeout(800);
  await snap('delete-confirm');
  await page.locator('.Modal button:has-text("Delete")').last().click();
  await page.waitForTimeout(3000);
  await snap('delete');
}

if (steps.includes('photo')) {
  await page.locator('.AttachMenu--button').first().click();
  await page.waitForTimeout(800);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.AttachMenu--menu .MenuItem').first().click(),
  ]);
  await chooser.setFiles(process.env.PHOTO || '/test/sample.png');
  await page.waitForTimeout(2500);
  await snap('photo-modal');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
  await snap('photo-sent');
}

if (steps.includes('recovery')) {
  await page.locator('.LeftMainHeader .DropdownMenu button').first().click();
  await page.waitForTimeout(700);
  await page.locator('.MenuItem:has-text("Settings")').first().click();
  await page.waitForTimeout(1500);
  await page.locator('.ListItem:has-text("Encryption")').first().click();
  await page.waitForTimeout(1000);
  await page.fill('#matrix-recovery-key', readFileSync('/test/recovery_key', 'utf8').trim());
  await snap('recovery-modal');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(12000);
  await snap('recovery-done');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
}

if (steps.includes('reopen')) {
  await page.locator(`.ListItem.Chat:has-text("${process.env.CHAT_TITLE}")`).first().click();
  await page.waitForTimeout(4000);
  await snap('reopen');
}

if (steps.includes('dom')) {
  console.log('DOM', await page.evaluate(() => {
    const list = document.querySelector('.MessageList');
    const msgs = [...document.querySelectorAll('.MessageList .Message')].map((el) => {
      const r = el.getBoundingClientRect();
      return `${el.id} ${Math.round(r.top)}/${Math.round(r.height)} ${getComputedStyle(el).opacity} ${el.className.slice(0, 80)} :: ${el.textContent.slice(0, 40)}`;
    });
    return JSON.stringify({ scrollTop: list?.scrollTop, scrollHeight: list?.scrollHeight, clientHeight: list?.clientHeight, msgs }, undefined, 1);
  }));
  await page.locator('.MessageList ~ .FloatingActionButtons button, button[aria-label="Go to bottom"]').first().click().catch(() => undefined);
  await page.waitForTimeout(1500);
  await snap('after-down');
}

async function openNewMenu(itemText) {
  await page.locator('#LeftColumn .FloatingActionButton, .NewChatButton button').first().hover();
  await page.locator('#LeftColumn .FloatingActionButton, .NewChatButton button').first().click();
  await page.waitForTimeout(800);
  await snap('new-menu');
  await page.locator(`.MenuItem:has-text("${itemText}")`).first().click();
  await page.waitForTimeout(1500);
}

if (steps.includes('newgroup')) {
  await openNewMenu(process.env.NEW_KIND || 'New Group');
  await snap('newgroup-picker');
  await page.locator(`#LeftColumn .ListItem:has-text("${process.env.MEMBER || 'Sara Test'}")`).first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  await snap('newgroup-selected');
  await page.locator('#LeftColumn .FloatingActionButton:visible').last().click();
  await page.waitForTimeout(1200);
  await page.locator('#LeftColumn input.form-control:visible').first().fill(process.env.GROUP_NAME || 'Created from Peyvand');
  await snap('newgroup-name');
  await page.locator('#LeftColumn .FloatingActionButton:visible').last().click();
  await page.waitForTimeout(6000);
  await snap('newgroup-created');
}

if (steps.includes('newmessage')) {
  await openNewMenu('New Message');
  await snap('newmessage-list');
  await page.locator('#LeftColumn input:visible').first().fill(process.env.SEARCH || 'teletest2');
  await page.waitForTimeout(2500);
  await snap('newmessage-search');
  await page.locator('#LeftColumn .ListItem:visible').first().click();
  await page.waitForTimeout(3000);
  await snap('newmessage-open');
}

if (steps.includes('searchsend')) {
  await page.locator('#LeftMainHeader input').first().click();
  await page.keyboard.type(process.env.SEARCH || 'teletest3');
  await page.waitForTimeout(8000);
  await snap('search-results');
  await page.locator('#LeftColumn .search-result, #LeftColumn .ListItem:visible').filter({ hasText: process.env.SEARCH || 'teletest3' }).first().click({ timeout: 5000 })
    .catch(() => push('[test] search result not found'));
  await page.waitForTimeout(3000);
  await snap('search-open');
  await page.locator('#editable-message-text').click({ timeout: 5000 }).catch(() => push('[test] no composer'));
  await page.keyboard.type('Hello new contact');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
  await snap('search-sent');
}

async function attach(menuIndex, file) {
  await page.locator('.AttachMenu--button').first().click();
  await page.waitForTimeout(800);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.AttachMenu--menu .MenuItem').nth(menuIndex).click(),
  ]);
  await chooser.setFiles(file);
  await page.waitForTimeout(3000);
  await snap(`attach-${menuIndex}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
}

if (steps.includes('video')) {
  await attach(0, '/test/sample.mp4');
  await snap('video-sent');
}

if (steps.includes('file')) {
  await attach(1, '/test/sample.pdf');
  await snap('file-sent');
}

if (steps.includes('voice')) {
  const recordButton = page.locator('.Composer .main-button, button[aria-label="Record voice message"]').last();
  await recordButton.click();
  await page.waitForTimeout(3500);
  await snap('voice-recording');
  await recordButton.click();
  await page.waitForTimeout(6000);
  await snap('voice-sent');
}

if (steps.includes('roundvideo')) {
  const recordButton = page.locator('.Composer .main-button').last();
  await recordButton.click({ button: 'right' });
  await page.waitForTimeout(1000);
  await snap('record-mode-menu');
  await page.getByText('Video Message').first().click({ timeout: 5000 })
    .catch(() => push('[test] no video mode item'));
  await page.waitForTimeout(800);
  await recordButton.click();
  await page.waitForTimeout(4000);
  await snap('round-recording');
  await recordButton.click();
  await page.waitForTimeout(9000);
  await snap('round-sent');
}

if (steps.includes('chatsearch')) {
  await page.locator('.MiddleHeader button[aria-label="Search this chat"], .MiddleHeader .tools button').first().click();
  await page.waitForTimeout(1000);
  await page.keyboard.type(process.env.CHAT_QUERY || 'Unread test');
  await page.waitForTimeout(5000);
  await snap('chat-search');
}

if (steps.includes('playvideo')) {
  await page.locator('.Message .media-inner').first().click();
  await page.waitForTimeout(5000);
  console.log('VIDEO', await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => `${v.currentSrc.slice(0, 80)} t=${v.currentTime.toFixed(1)} ready=${v.readyState} err=${v.error?.code}`).join(' | ')));
  await snap('video-playing');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
}

if (steps.includes('playvoice')) {
  await page.locator('.Message .Audio button, .Message .toggle-play').last().click();
  await page.waitForTimeout(2500);
  console.log('AUDIO', await page.evaluate(() => [...document.querySelectorAll('audio')].map((a) => `t=${a.currentTime.toFixed(1)} err=${a.error?.code}`).join(' | ')));
  await snap('voice-playing');
}

if (steps.includes('wait')) {
  await page.waitForTimeout(Number(process.env.WAIT || 10000));
  await snap('waited');
}

console.log(logs.join('\n'));
await browser.close();
