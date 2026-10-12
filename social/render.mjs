// Renders the social announcement card to assets/cask-q-announcement.png.
// Usage: node social/render.mjs   (requires playwright)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(here, 'cask-q-announcement.html'));
await page.screenshot({ path: path.join(here, '..', 'assets', 'cask-q-announcement.png') });
await browser.close();
