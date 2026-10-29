// Renders the November ship calendar card to assets/november-ship-calendar.png.
// Usage: node social/render-calendar.mjs   (requires playwright)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(here, 'november-ship-calendar.html'), { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(here, '..', 'assets', 'november-ship-calendar.png') });
await browser.close();
