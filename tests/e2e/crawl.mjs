// Visits the main screens to collect untranslated UI strings reported by debug builds
import { chromium } from '/app/node_modules/playwright-core/index.mjs';

const url = process.env.APP_URL || 'http://127.0.0.1:18091/';
const context = await chromium.launchPersistentContext(`/test/profile-${process.env.ACCOUNT || 1}`, {
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  viewport: { width: 1280, height: 800 },
});
const page = context.pages()[0] || await context.newPage();
const missing = new Set();
const errors = [];
page.on('console', (msg) => {
  const m = msg.text().match(/\[lang\] Missing translation: (\w+)/);
  if (m) missing.add(m[1]);
});
page.on('pageerror', (err) => errors.push(err.message));

const wait = (ms) => page.waitForTimeout(ms);
const tryClick = async (selector, ms = 900) => {
  const el = page.locator(selector).first();
  if (await el.count()) {
    await el.click({ timeout: 3000 }).catch(() => undefined);
    await wait(ms);
    return true;
  }
  return false;
};
const back = async () => {
  await page.keyboard.press('Escape');
  await wait(600);
};

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#LeftColumn', { timeout: 30000 });
await wait(3000);

// Chats and message context menus
for (const index of [0, 1]) {
  await page.locator('.ListItem.Chat').nth(index).click().catch(() => undefined);
  await wait(2500);
  await page.locator('.Message .message-content').last().click({ button: 'right' }).catch(() => undefined);
  await wait(800);
  await back();
  await page.locator('.Message.own .message-content').last().click({ button: 'right' }).catch(() => undefined);
  await wait(800);
  await back();
  await page.locator('.ActionMessage').first().click({ button: 'right' }).catch(() => undefined);
  await wait(600);
  await back();
  // Chat header menu and profile
  await tryClick('.MiddleHeader .HeaderActions button:last-child');
  await back();
  await tryClick('.MiddleHeader .ChatInfo', 1500);
  await back();
  // Attach and emoji menus
  await tryClick('.AttachMenu--button');
  await back();
  await tryClick('.symbol-menu-button', 1500);
  await back();
}

// Chat list context menu
await page.locator('.ListItem.Chat').first().click({ button: 'right' }).catch(() => undefined);
await wait(800);
await back();

// Main menu and its entries
if (await tryClick('.LeftMainHeader .DropdownMenu button')) {
  await tryClick('.MenuItem:has(.icon-more)', 800);
  await back();
}
await tryClick('.LeftMainHeader .DropdownMenu button');
await tryClick('.MenuItem:has(.icon-settings)', 1500);
const settingsItems = await page.locator('#Settings .ListItem').count();
for (let i = 0; i < settingsItems; i++) {
  await page.locator('#Settings .ListItem').nth(i).click({ timeout: 3000 }).catch(() => undefined);
  await wait(1200);
  await back();
  await wait(400);
}
await back();

// New chat menu
await tryClick('#LeftColumn .FloatingActionButton, .NewChatButton button');
await wait(800);
await back();

// Search
await tryClick('#telegram-search-input, .SearchInput input');
await page.keyboard.type('te');
await wait(2500);
await back();

console.log(JSON.stringify({ missing: [...missing].sort(), errors }, undefined, 1));
await context.close();
