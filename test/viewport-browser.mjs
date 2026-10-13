// Isolated built-UI checks: no accounts, real media, capture, or production party.
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { createApp } from '../server/index.mjs';

const item = (id, title, type = 'movie') => ({ id, title, type, duration: 5400, year: 2026, hasPoster: false });
const catalog = [item('series', 'The Cat Chronicles', 'show'), ...Array.from({ length: 80 }, (_, i) => item(`movie-${i}`, `Cat Movie ${String(i + 1).padStart(2, '0')}`))];
const seasons = [item('season', 'Season 1', 'season')];
const episodes = Array.from({ length: 60 }, (_, i) => ({ ...item(`episode-${i}`, `Cat Episode ${String(i + 1).padStart(2, '0')}`, 'episode'), episodeTitle: `Season 1 · Episode ${i + 1}` }));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const { server, party, close } = createApp({
  plex: { canAccess: async () => true, streams: new Map(), stop: async () => {},
    image: async () => new Response('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#30343a"/><text x="400" y="260" text-anchor="middle" font-size="100">🐈</text></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    library: async ({ query, parent }) => {
    const items = parent === 'series' ? seasons : parent === 'season' ? episodes : catalog;
    return query ? items.filter(item => item.title.toLowerCase().includes(query.toLowerCase())) : items;
  } },
  origin: base, assetsRoot: path.resolve(process.env.TEST_BUILD_DIR || 'test-results/viewport-build'), recordProgress: false,
  livekitKey: 'fixture-key', livekitSecret: 'fixture-only-secret'.repeat(2),
  livekitInternalUrl: 'http://127.0.0.1:9', roomName: `viewport-${randomUUID()}`,
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const captures = path.resolve('test-results/viewport-review');
await mkdir(captures, { recursive: true });
let browser;

async function resize(page, viewport) {
  await page.setViewportSize(viewport);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function bounds(page, selector, label) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `${label}: ${selector} must be visible.`);
  const viewport = await page.evaluate(() => ({ width: visualViewport?.width || innerWidth, height: visualViewport?.height || innerHeight }));
  assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    `${label}: ${selector} extends outside the visible viewport: ${JSON.stringify({ box, viewport })}`);
  return box;
}

async function locked(page, label) {
  const result = await page.evaluate(() => ({
    x: scrollX, y: scrollY, scale: visualViewport?.scale || 1,
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth, viewportHeight: innerHeight,
  }));
  assert.equal(result.x, 0, `${label}: document must not pan horizontally.`);
  assert.equal(result.y, 0, `${label}: document must not pan vertically.`);
  assert.equal(result.scale, 1, `${label}: viewport scale must remain 1.`);
  assert.ok(result.width <= result.viewportWidth && result.height <= result.viewportHeight,
    `${label}: document must fit the viewport: ${JSON.stringify(result)}`);
}

async function swipe(cdp, x, fromY, toY) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY, id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: fromY + (toY - fromY) * i / 8, id: 1 }] });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function pageGestures(page, cdp, label) {
  const viewport = page.viewportSize();
  await page.mouse.move(5, Math.floor(viewport.height / 2));
  await page.mouse.wheel(700, 700);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -600);
  await page.keyboard.up('Control');
  if (cdp) {
    await swipe(cdp, 8, viewport.height * .8, viewport.height * .2);
    await cdp.send('Input.synthesizePinchGesture', { x: viewport.width / 2, y: viewport.height / 2, scaleFactor: 1.8, gestureSourceType: 'touch' });
  }
  await page.waitForTimeout(100);
  await locked(page, `${label}: real wheel${cdp ? '/touch/pinch' : ''}`);
  const guards = await page.evaluate(() => {
    const prevented = type => { const event = new Event(type, { bubbles: true, cancelable: true }); document.body.dispatchEvent(event); return event.defaultPrevented; };
    const touch = count => { const event = new Event('touchmove', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'touches', { value: Array(count).fill({}) }); document.body.dispatchEvent(event); return event.defaultPrevented; };
    return { gestureStart: prevented('gesturestart'), gestureChange: prevented('gesturechange'), pinch: touch(2), singleFinger: touch(1) };
  });
  assert.deepEqual(guards, { gestureStart: true, gestureChange: true, pinch: true, singleFinger: false }, `${label}: pinch fallback must leave single-finger input intact.`);
}

async function scrollCatalog(page, cdp, label) {
  const box = await bounds(page, '.library-scroll', label);
  assert.ok(await page.locator('.library-scroll').evaluate(node => node.scrollHeight > node.clientHeight), `${label}: fixture must overflow the internal catalog.`);
  if (cdp && box.height >= 70) {
    await swipe(cdp, box.x + box.width / 2, box.y + box.height - 12, box.y + 12);
    await page.waitForFunction(() => document.querySelector('.library-scroll').scrollTop > 0);
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Keep mobile scrolling on the trusted touch path: mixing wheel with a
  // compositor-owned touch fling is unreliable in mobile Chromium emulation.
  let remaining;
  for (let attempt = 0; attempt < 24; attempt++) {
    if (cdp) await swipe(cdp, box.x + box.width / 2, box.y + box.height - 12, box.y + 12);
    else await page.mouse.wheel(0, 20000);
    await page.waitForTimeout(100);
    remaining = await page.locator('.library-scroll').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
    if (remaining <= 2) break;
  }
  assert.ok(remaining <= 2, `${label}: scrolling must reach the last item (${remaining}px remaining).`);
  await bounds(page, '.library-scroll button:last-child', `${label}: last catalog item`);
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(80);
  await locked(page, `${label}: catalog boundary must not move outer page`);
}

try {
  for (const engine of ['chromium', 'webkit']) {
    browser = await (engine === 'chromium' ? chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true }) : webkit.launch({ headless: true }));
    for (const mobile of engine === 'chromium' ? [false, true] : [true]) {
      const mode = mobile ? 'mobile' : 'desktop';
      // Playwright refuses wheel input in mobile WebKit. A narrow touch-enabled
      // WebKit viewport still exercises the mobile CSS and real wheel default.
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile && engine === 'chromium', hasTouch: mobile });
      const page = await context.newPage(), errors = [];
      const cdp = engine === 'chromium' && mobile ? await context.newCDPSession(page) : undefined;
      let login = false, busy = false, preview = false;
      await page.route('**/api/session', route => route.fulfill({ json: {
        canHost: !login && !busy, hostBusy: busy, ...(login ? { loginUrl: '/login' } : {}),
        state: { ...party.snapshot(), ...(preview ? { movie: { ...episodes[0], seriesTitle: 'The Cat Chronicles', episodeDetails: 'Season 1 · Episode 1' } } : {}) },
      } }));
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(base);
        await page.locator('#host').waitFor();
        await page.locator('#name').fill('Alex Cat');
        await bounds(page, '#name', `${engine}/${mode} Join`);
        await bounds(page, '#host', `${engine}/${mode} Join`);
        await bounds(page, '.join-button', `${engine}/${mode} Join`);
        assert.ok(await page.locator('#name').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16), 'Text input must avoid iOS focus zoom.');
        await pageGestures(page, cdp, `${engine}/${mode} Join`);
        await page.screenshot({ path: path.join(captures, `${engine}-${mode}-join.png`) });

        if (mobile) {
          preview = true;
          await page.reload();
          await page.locator('.joining-movie').waitFor();
          await page.locator('#name').fill('Alex Cat');
          for (const height of [844, 668, 568]) {
            await resize(page, { width: 390, height });
            await page.screenshot({ path: path.join(captures, `${engine}-preview-${height}.png`) });
            await bounds(page, '#name', `${engine} active-movie join at ${height}px`);
            await bounds(page, '.join-button', `${engine} active-movie join at ${height}px`);
            const card = await bounds(page, '.joining-movie', `${engine} active-movie join at ${height}px`);
            for (const selector of ['.series-name', '.episode-name', '.episode-details']) {
              const text = await bounds(page, selector, `${engine} active-movie join at ${height}px`);
              assert.ok(text.y >= card.y - 1 && text.y + text.height <= card.y + card.height + 1,
                `${engine} ${height}px: ${selector} must remain inside its clipped preview: ${JSON.stringify({ card, text })}`);
            }
            await locked(page, `${engine} active-movie join at ${height}px`);
          }
          preview = false;
          await page.reload();
          await page.locator('#host').waitFor();
        }
        if (mobile) for (const viewport of [{ width: 844, height: 390 }, { width: 320, height: 480 }, { width: 390, height: 360 }]) {
          await resize(page, viewport);
          await bounds(page, '#name', `${engine} ${viewport.width}x${viewport.height}`);
          await bounds(page, '#host', `${engine} ${viewport.width}x${viewport.height}`);
          await bounds(page, '.join-button', `${engine} ${viewport.width}x${viewport.height}`);
          await locked(page, `${engine} ${viewport.width}x${viewport.height}`);
          if (viewport.height === 360) await page.screenshot({ path: path.join(captures, `${engine}-short-join.png`) });
        }
        login = true;
        await page.reload();
        await page.getByRole('link', { name: 'Sign in to host' }).waitFor();
        await bounds(page, '.join-button', `${engine}/${mode} sign-in`);
        await bounds(page, '.host-login-link', `${engine}/${mode} sign-in`);
        await locked(page, `${engine}/${mode} sign-in`);
        login = false; busy = true;
        await page.reload();
        await page.locator('#host-busy').waitFor();
        await bounds(page, '.join-button', `${engine}/${mode} busy host`);
        await bounds(page, '#host-busy', `${engine}/${mode} busy host`);
        await locked(page, `${engine}/${mode} busy host`);
        busy = false;
        await resize(page, mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
        await page.reload();
        await page.locator('#name').fill('Alex Cat');
        await page.getByRole('switch', { name: 'I am the host' }).check();
        const joining = page.waitForResponse(response => response.url() === `${base}/api/join` && response.request().method() === 'POST');
        await page.getByRole('button', { name: 'Join', exact: true }).click();
        const joined = await joining;
        assert.equal(joined.status(), 200, `Fixture host join failed: ${await joined.text()}`);
        assert.equal((await joined.json()).owner, true, 'Checked host switch must request hosting.');
        await page.getByRole('button', { name: 'Choose a movie', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Choose a movie', exact: true }).click();
        await page.locator('.poster-item').first().waitFor();
        await bounds(page, '.library', `${engine}/${mode} picker`);
        await page.screenshot({ path: path.join(captures, `${engine}-${mode}-picker.png`) });
        await scrollCatalog(page, cdp, `${engine}/${mode} picker`);
        await page.locator('.library-scroll').evaluate(node => { node.scrollTop = 0; });
        await page.getByRole('button', { name: /^The Cat Chronicles/ }).click();
        await page.getByRole('button', { name: /^Season 1/ }).click();
        await page.locator('.episode').first().waitFor();
        await scrollCatalog(page, cdp, `${engine}/${mode} episode drill-down`);
        if (mobile) {
          await resize(page, { width: 844, height: 390 });
          await bounds(page, '.library', `${engine} landscape episode picker`);
          await bounds(page, '.library-scroll', `${engine} landscape episode picker`);
          await page.locator('.library-scroll').evaluate(node => { node.scrollTop = 0; });
          await scrollCatalog(page, cdp, `${engine} landscape episode picker`);
          await page.screenshot({ path: path.join(captures, `${engine}-landscape-picker.png`) });
        }
        await page.getByRole('button', { name: 'Close movie picker' }).click();
        await page.getByRole('button', { name: 'Leave the call' }).click();
        await page.getByRole('button', { name: 'Join', exact: true }).waitFor();
        assert.deepEqual(errors, [], `${engine}/${mode}: no browser runtime errors.`);
        console.log(`${engine}/${mode}: outer page locked; pinch guards intact; Join/sign-in/host status fit short viewports; catalog and episode lists still scroll.`);
      } finally { await context.close(); }
    }
    await browser.close(); browser = undefined;
  }
  console.log('Chromium exercised trusted touch/swipe/pinch; Linux WebKit verified layout, wheel, and Safari guard wiring, not native iPhone gestures.');
} finally { await browser?.close(); await close(); }
