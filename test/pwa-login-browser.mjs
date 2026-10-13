// Safari tabs share cookies; an iOS Home Screen app can use a separate jar.
// Two isolated contexts reproduce that boundary, not a physical iPhone.
// Real Caddy routing keeps the existing external login in the app's origin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { createApp } from '../server/index.mjs';
import { cookies, ownerAuthenticator } from '../server/auth.mjs';
import { Plex } from '../server/plex.mjs';

assert.ok(process.env.TEST_CADDY, 'Set TEST_CADDY to an installed Caddy executable.');
const caddyBinary = path.resolve(process.env.TEST_CADDY);
const providerHost = 'login.fixture.invalid';
const cookieName = 'fixture_host_session', fixtureSession = randomUUID();
const providerRequests = [], fixtureErrors = [];
let directory, pms, provider, application, caddy, caddyExited, browser;
let caddyLog = '';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const stopHttp = async server => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

try {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'playparty-pwa-login-'));
  pms = http.createServer((req, res) => {
    if (req.url !== '/library/sections') return json(res, 404, {});
    json(res, 200, { MediaContainer: { size: 0, Directory: [] } });
  });
  const pmsPort = await listen(pms);
  provider = http.createServer(async (req, res) => {
    try {
      // This is the existing provider's session endpoint, called server-side.
      if (req.url === '/api/session') {
        return json(res, 200, { authenticated: cookies(req.headers.cookie)[cookieName] === fixtureSession });
      }
      providerRequests.push(req.url);
      assert.equal(req.headers.host, providerHost, 'Caddy must preserve the external provider Host rewrite.');
      if (req.url === '/api/grid' || req.url === '/api/login/status') return json(res, 200, {});
      if (req.url === '/login' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(`<!doctype html><html><body><h1>Existing external login</h1>
          <form><label>Username<input name="username" autocomplete="username"></label>
          <label>Password<input name="password" type="password" autocomplete="current-password"></label>
          <button disabled>Sign in</button><p role="alert"></p></form>
          <script>
            Promise.all(['/api/grid', '/api/login/status'].map(url => fetch(url).then(r => {
              if (!r.ok) throw Error('Provider routing failed'); return r.json();
            }))).then(() => document.querySelector('button').disabled = false);
            document.querySelector('form').onsubmit = async event => {
              event.preventDefault();
              const body = Object.fromEntries(new FormData(event.target));
              const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
              if (response.ok) location.assign('/');
              else document.querySelector('[role=alert]').textContent = 'Invalid fixture credentials';
            };
          </script></body></html>`);
      }
      if (req.url === '/api/login' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const credentials = JSON.parse(body);
        if (credentials.username !== 'fixture-user' || credentials.password !== 'fixture-password') return json(res, 401, {});
        res.setHeader('Set-Cookie', `${cookieName}=${fixtureSession}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
        return json(res, 200, { ok: true });
      }
      json(res, 404, {});
    } catch (error) { fixtureErrors.push(error.message); json(res, 500, {}); }
  });
  const providerPort = await listen(provider);
  const reserve = http.createServer();
  const publicPort = await listen(reserve);
  await stopHttp(reserve);
  const origin = `http://127.0.0.1:${publicPort}`;
  application = createApp({
    plex: new Plex({ url: `http://127.0.0.1:${pmsPort}` }),
    authenticateOwner: ownerAuthenticator(`http://127.0.0.1:${providerPort}/api/session`, [cookieName]),
    loginUrl: '/login', origin, recordProgress: false,
    assetsRoot: path.resolve(process.env.TEST_BUILD_DIR || 'dist'),
  });
  const appPort = await listen(application.server);
  const configuration = path.join(directory, 'Caddyfile');
  await fs.writeFile(configuration, `{
    admin off
    auto_https off
    persist_config off
  }
  ${origin} {
    @host_login path /login /api/grid /api/login /api/login/*
    handle @host_login {
      reverse_proxy 127.0.0.1:${providerPort} {
        header_up Host ${providerHost}
      }
    }
    handle {
      reverse_proxy 127.0.0.1:${appPort}
    }
  }
  `);
  caddy = spawn(caddyBinary, ['run', '--config', configuration, '--adapter', 'caddyfile'], {
    cwd: directory, env: { ...process.env, XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  caddyExited = new Promise(resolve => caddy.once('close', resolve));
  caddy.on('error', error => { caddyLog += error.message; });
  for (const output of [caddy.stdout, caddy.stderr]) output.on('data', chunk => { caddyLog = (caddyLog + chunk).slice(-4000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready || caddy.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, `The isolated Caddy fixture must start: ${caddyLog}`);

  const engines = [{ name: 'Chromium desktop', engine: chromium, options: { viewport: { width: 1440, height: 900 } } }];
  try {
    await fs.access(webkit.executablePath());
    engines.push({ name: 'Mobile WebKit', engine: webkit, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
  } catch { console.log('Mobile WebKit skipped: managed Playwright WebKit is not installed.'); }
  for (const { name, engine, options } of engines) {
    browser = await engine.launch({ headless: true, ...(engine === chromium ? { executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome' } : {}) });
    const safari = await browser.newContext(options), pwa = await browser.newContext(options);
    const pageErrors = [], popups = [];
    try {
      // Fixture credentials only. No production browser, account or cookie is used.
      await safari.addCookies([{ name: cookieName, value: fixtureSession, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      let safariPage = await safari.newPage();
      await safariPage.goto(origin);
      await safariPage.getByRole('switch', { name: 'I am the host' }).waitFor();
      await safariPage.close();
      safariPage = await safari.newPage();
      await safariPage.goto(origin);
      await safariPage.getByRole('switch', { name: 'I am the host' }).waitFor();
      assert.equal((await safariPage.request.get(`${origin}/api/session`)).ok(), true);
      assert.equal((await (await safariPage.request.get(`${origin}/api/session`)).json()).canHost, true);

      const page = await pwa.newPage();
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('popup', popup => popups.push(popup));
      await page.goto(origin);
      const signIn = page.getByRole('link', { name: 'Sign in to host', exact: true });
      await signIn.waitFor();
      assert.equal(await page.locator('#host').count(), 0, 'Safari login cannot authorize a separate app cookie jar.');
      assert.equal((await (await page.request.get(`${origin}/api/session`)).json()).canHost, false);
      assert.equal((await pwa.cookies(origin)).some(cookie => cookie.name === cookieName), false);
      assert.equal(await signIn.getAttribute('href'), '/login');
      assert.equal(await signIn.getAttribute('target'), null, 'Login must stay in this app window.');
      const unauthorized = await page.request.post(`${origin}/api/join`, { data: { name: 'Forbidden host', host: true }, headers: { Origin: origin } });
      assert.equal(unauthorized.status(), 403, 'Hiding the checkbox must also enforce host access on the backend.');
      assert.equal((await unauthorized.json()).error, 'An accessible Plex server is required to host.');

      await page.getByRole('textbox', { name: 'Your name' }).fill('PWA fixture host');
      await signIn.click();
      await page.getByRole('heading', { name: 'Existing external login' }).waitFor();
      assert.equal(page.url(), `${origin}/login`);
      await page.getByRole('textbox', { name: 'Username', exact: true }).fill('fixture-user');
      await page.getByLabel('Password', { exact: true }).fill('fixture-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const host = page.getByRole('switch', { name: 'I am the host' });
      await host.waitFor();
      assert.equal(page.url(), `${origin}/`);
      assert.equal(await page.getByRole('textbox', { name: 'Your name' }).inputValue(), 'PWA fixture host');
      assert.equal(await host.isChecked(), false, 'Signing in must preserve the explicit viewer default.');
      assert.equal(await page.getByRole('link', { name: 'Sign in to host', exact: true }).count(), 0);
      const session = await (await page.request.get(`${origin}/api/session`)).json();
      assert.equal(session.canHost, true);
      assert.ok(session.state && !Object.hasOwn(session, 'authenticated'), '/api/session must remain the Playparty endpoint.');
      const cookie = (await pwa.cookies(origin)).find(item => item.name === cookieName);
      assert.ok(cookie?.httpOnly && cookie.value === fixtureSession, 'The provider must issue a real same-origin HttpOnly cookie.');
      assert.equal((await safari.cookies(origin)).find(item => item.name === cookieName)?.value, fixtureSession);
      assert.equal(safari.pages().length, 1);
      assert.equal(pwa.pages().length, 1);
      assert.equal(popups.length, 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(pageErrors, []);
      console.log(`${name}: separate cookie jars, tab persistence, same-window external login, preserved name and backend host enforcement passed.`);
    } finally { await Promise.all([safari.close(), pwa.close()]); await browser.close(); browser = undefined; }
  }
  for (const route of ['/login', '/api/grid', '/api/login', '/api/login/status']) assert.ok(providerRequests.includes(route), `The real proxy must route ${route} to the existing provider.`);
  assert.deepEqual(fixtureErrors, []);
} finally {
  await browser?.close();
  if (caddy && caddy.exitCode === null && caddy.signalCode === null) {
    caddy.kill('SIGTERM');
    const timeout = setTimeout(() => caddy.kill('SIGKILL'), 5000);
    timeout.unref();
    await caddyExited;
    clearTimeout(timeout);
  }
  await application?.close();
  await Promise.all([stopHttp(provider), stopHttp(pms)]);
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}
