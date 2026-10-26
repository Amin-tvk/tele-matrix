import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { readFileSync } from 'fs';
const svg = readFileSync('/brand/logo.svg', 'utf8');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
const outputs = [
  ['icon-192x192.png', 192, 0], ['icon-384x384.png', 384, 0], ['icon-512x512.png', 512, 0],
  ['favicon-16x16.png', 16, 0], ['favicon-32x32.png', 32, 0], ['mstile-150x150.png', 150, 0],
  ['apple-touch-icon.png', 180, 1], ['icon-square-192x192.png', 192, 1], ['icon-square-384x384.png', 384, 1],
  ['icon-square-512x512.png', 512, 1], ['icon-electron-macos.png', 512, 0],
];
for (const [name, size, isSquare] of outputs) {
  await page.setViewportSize({ width: size, height: size });
  const background = isSquare ? 'background:linear-gradient(135deg,#20C3A5,#1A6FE0);' : 'background:transparent;';
  const inner = isSquare ? svg.replace(/<circle cx="256" cy="256" r="256"[^>]*\/>/, '') : svg;
  await page.setContent(`<html><body style="margin:0;${background}"><img style="width:${size}px;height:${size}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(inner).toString('base64')}"></body></html>`);
  await page.waitForTimeout(100);
  await page.screenshot({ path: `/brand/out/${name}`, omitBackground: !isSquare });
}
await browser.close();
