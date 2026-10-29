// Renders the link preview card to assets/og-image-v2.jpg (1200x630, ~100 KB
// so WhatsApp and others that cap preview size still show it).
// Usage: node social/render-og.mjs   (requires playwright)
// Use a new filename whenever the image changes: /assets/* is served with a
// one-year immutable cache, and X caches cards by image URL.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto('file://' + path.join(here, 'og-card.html'), { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(here, '..', 'assets', 'og-image-v2.jpg'), type: 'jpeg', quality: 88 });
await browser.close();
