// New account: set up a recovery key with a security phrase, then restore with it on a fresh device
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { readFileSync, rmSync } from 'fs';
const [user, password] = readFileSync('/test/creds.txt', 'utf8').trim().split('\n')
  .find((l) => l.startsWith(`${process.env.TUSER} `)).split(' ');
const PHRASE = 'blue river quiet lamp';
const url = process.env.APP_URL || 'https://tele.peyvand-yar.ir/';

async function open(profile) {
  rmSync(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1280, height: 800 },
  });
  const page = context.pages()[0] || await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#matrix-username', { timeout: 30000 });
  await page.fill('#matrix-username', user);
  await page.fill('#matrix-password', password);
  await page.click('#auth-matrix-form button[type=submit]');
  await page.waitForSelector('#LeftColumn', { timeout: 30000 });
  await page.waitForTimeout(6000);
  return { context, page };
}

async function openEncryption(page) {
  if (await page.getByText('Encryption', { exact: true }).isVisible()) {
    await page.getByText('Encryption', { exact: true }).click();
    await page.waitForTimeout(3000);
    return;
  }
  await page.locator('#LeftMainHeader .DropdownMenu button').first().click();
  await page.getByText('Settings', { exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByText('Encryption', { exact: true }).click();
  await page.waitForTimeout(3000);
}

// Device A: first setup
let { context, page } = await open('/test/profile-rs-a');
await openEncryption(page);
console.log('A title:', await page.locator('.modal-title').innerText());
await page.screenshot({ path: '/test/rs-1-setup.png' });
await page.fill('#matrix-recovery-passphrase', PHRASE);
await page.getByRole('button', { name: 'Create Key' }).click();
await page.waitForSelector('text=Your Recovery Key', { timeout: 60000 }).catch(() => {});
await page.getByRole('button', { name: 'Copy' }).click().catch(() => {});
console.log('clipboard toast:', await page.getByText('Text copied').isVisible().catch(() => false));
await page.screenshot({ path: '/test/rs-2-key.png' });
const key = await page.locator('[class*="recoveryKey"]').innerText().catch(() => '');
console.log('A key:', key ? `${key.slice(0, 9)}… (${key.length} chars)` : 'NONE', await page.locator('[class*="error"]').allInnerTexts());
await page.getByRole('button', { name: 'I Saved It' }).click().catch(() => {});
await openEncryption(page);
console.log('A reopened title:', await page.locator('.modal-title').innerText());
await page.screenshot({ path: '/test/rs-3-ready.png' });
await context.close();

// Device B: restore with the security phrase
({ context, page } = await open('/test/profile-rs-b'));
await openEncryption(page);
console.log('B title:', await page.locator('.modal-title').innerText());
await page.fill('#matrix-recovery-key', PHRASE);
await page.getByRole('button', { name: 'Restore' }).click();
await page.waitForTimeout(15000);
console.log('B result:', await page.locator('.modal-dialog').innerText());
await page.screenshot({ path: '/test/rs-4-restore.png' });
await context.close();
