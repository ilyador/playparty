// Exercise the built Join page without accounts, real media or call capture.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';

const pms = http.createServer((req, res) => {
  assert.equal(req.url, '/library/sections');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ MediaContainer: { size: 0, Directory: [] } }));
});
await new Promise(resolve => pms.listen(0, '127.0.0.1', resolve));
const plex = new Plex({ url: `http://127.0.0.1:${pms.address().port}` });
const { server, close } = createApp({ plex, assetsRoot: path.resolve(process.env.TEST_BUILD_DIR || 'dist'), recordProgress: false });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    let requests = 0, release;
    const stalled = new Promise(resolve => { release = resolve; });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/session', async route => {
      if (++requests === 1) {
        await stalled;
        await route.abort().catch(() => {});
      } else await route.continue();
    });
    try {
      const firstRequest = page.waitForRequest('**/api/session');
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await firstRequest;
      assert.equal(await page.locator('#host').count(), 0, 'Unknown access never flashes a host switch.');
      await page.getByRole('textbox', { name: 'Your name' }).fill('Recovery test');
      const host = page.getByRole('switch', { name: 'I am the host' });
      await host.waitFor({ timeout: 15000 });
      assert.ok(requests >= 2, 'A pending first request cannot block fresh discovery.');
      assert.equal(await host.isChecked(), false);
      assert.equal(await page.locator('#name').inputValue(), 'Recovery test');
      assert.equal(await page.locator('.inline-error').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      console.log(`${viewport.width}px: host option recovered from a stalled first request, preserving name and viewer default.`);
    } finally { release(); await context.close(); }
  }
} finally {
  await browser?.close();
  await close();
  pms.closeAllConnections();
  await new Promise(resolve => pms.close(resolve));
}
