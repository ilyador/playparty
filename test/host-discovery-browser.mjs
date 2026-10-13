// Exercise the built Join page without accounts, real media or call capture.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';

const pms = http.createServer((req, res) => {
  assert.equal(req.url, '/library/sections');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ MediaContainer: { size: 0, Directory: [] } }));
});
await new Promise(resolve => pms.listen(0, '127.0.0.1', resolve));
const plex = new Plex({ url: `http://127.0.0.1:${pms.address().port}` });
const { server, party, close } = createApp({ plex, assetsRoot: path.resolve(process.env.TEST_BUILD_DIR || 'dist'), recordProgress: false,
  livekitKey: 'fixture-key', livekitSecret: 'fixture-only-secret'.repeat(2), livekitInternalUrl: 'http://127.0.0.1:9', roomName: `host-discovery-${randomUUID()}` });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const owner = await browser.newContext();
    let ownerSocket;
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

      // Another browser hosts the actual server-side party. The waiting visitor
      // keeps the page open to exercise the existing lightweight discovery poll.
      const base = `http://127.0.0.1:${server.address().port}`;
      const joined = await owner.request.post(`${base}/api/join`, { data: { name: 'Fixture Host', host: true } });
      assert.equal(joined.status(), 200);
      const cookie = (await owner.cookies(base)).map(value => `${value.name}=${value.value}`).join('; ');
      ownerSocket = new WebSocket(`${base.replace('http:', 'ws:')}/events`, { headers: { Cookie: cookie } });
      await new Promise((resolve, reject) => {
        ownerSocket.once('error', reject);
        ownerSocket.once('message', data => {
          const state = JSON.parse(data.toString());
          assert.equal(state.hostPresent, true);
          resolve();
        });
      });
      await page.waitForFunction(() => document.querySelector('#host')?.disabled === true);
      assert.equal(await host.isChecked(), false);
      assert.equal(await host.getAttribute('aria-describedby'), 'host-busy');
      assert.equal(await page.locator('#host-busy').textContent(), 'There is already an active session.');
      assert.equal(await page.getByRole('link', { name: 'Sign in to host' }).count(), 0);
      const conflict = await context.request.post(`${base}/api/join`, { data: { name: 'Competing Host', host: true } });
      assert.equal(conflict.status(), 409, 'A stale visitor cannot take over through the API.');
      const leave = await owner.request.post(`${base}/api/leave`, { data: {} });
      assert.equal(leave.status(), 200);
      assert.equal(party.members.size, 0, 'The empty party is automatically retired.');
      await page.waitForFunction(() => document.querySelector('#host')?.disabled === false);
      assert.equal(await host.isChecked(), false);
      assert.equal(await page.locator('#host-busy').count(), 0);
      assert.equal(await page.locator('#name').inputValue(), 'Recovery test');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      console.log(`${viewport.width}px: discovery recovers; an active host disables hosting; the last departure automatically clears the party and restores the switch.`);
    } finally { release(); ownerSocket?.terminate(); await owner.close(); await context.close(); }
  }
} finally {
  await browser?.close();
  await close();
  pms.closeAllConnections();
  await new Promise(resolve => pms.close(resolve));
}
