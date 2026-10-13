import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp } from '../server/index.mjs';
import { authIdentity, PlexOwnerLogin } from '../server/plex-auth.mjs';
import { writeConfiguration } from '../deploy/setup.mjs';

test('Plex sign-in binds the PIN to a browser and grants only the configured owner', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'playparty-auth-test-'));
  try {
    const filename = path.join(directory, 'identity.json');
    const identity = authIdentity(filename);
    assert.deepEqual(authIdentity(filename), identity);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    let email = 'owner@example.com';
    let completed = false;
    const login = new PlexOwnerLogin({ ownerEmail: email, identity, origin: 'https://party.example.com', fetcher: async (url, options) => {
      if (options.method === 'POST') {
        assert.deepEqual(JSON.parse(options.body), { jwk: identity.jwk, strong: true });
        return Response.json({ id: 1, code: 'public-pin-code' });
      }
      if (url.includes('/pins/1?')) {
        const jwt = new URL(url).searchParams.get('deviceJWT');
        const [header, payload, signature] = jwt.split('.');
        assert.equal(verify(null, Buffer.from(`${header}.${payload}`), createPublicKey({ key: identity.jwk, format: 'jwk' }), Buffer.from(signature, 'base64url')), true);
        assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, identity.id);
        return Response.json({ authToken: completed ? 'server-only-token' : null });
      }
      assert.equal(options.headers['X-Plex-Token'], 'server-only-token');
      return Response.json({ email });
    } });
    const plex = { token: 'test', streams: new Map(), stop: async () => {} };
    const { server, close } = createApp({ plex, plexLogin: login, authenticateOwner: login.authenticate, origin: 'https://party.example.com' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const complete = cookie => fetch(`${base}/api/auth/complete`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://party.example.com' } });
    try {
      assert.equal((await complete('')).status, 401);
      const begin = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
      const cookie = begin.headers.get('set-cookie').split(';')[0];
      const redirect = begin.headers.get('location');
      assert.ok(redirect.startsWith('https://app.plex.tv/auth#?'));
      assert.ok(!redirect.includes(identity.secret));
      assert.equal((await complete(cookie)).status, 401);
      completed = true; email = 'friend@example.com';
      assert.equal((await complete(cookie)).status, 403);
      assert.equal((await complete(cookie)).status, 401);
      email = 'OWNER@example.com';
      const retry = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
      const response = await complete(retry.headers.get('set-cookie').split(';')[0]);
      assert.equal(response.status, 200);
      const ownerCookie = response.headers.getSetCookie()[0].split(';')[0];
      assert.ok(!ownerCookie.includes('server-only-token'));
      assert.equal(await login.authenticate(ownerCookie), true);
      assert.equal(await login.authenticate(ownerCookie + 'x'), false);
      assert.equal(await login.authenticate('playparty_owner=forged.' + 'é'.repeat(43)), false);
      assert.equal((await fetch(`${base}/api/auth/complete`, { method: 'POST', headers: { Origin: 'https://evil.example.com', Cookie: cookie } })).status, 403);
    } finally { await close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('external auth exposes no Plex sign-in fallback and cannot trust a standalone cookie', async () => {
  const { server, close } = createApp({ plex: { streams: new Map(), stop: async () => {} }, authenticateOwner: async () => false, loginUrl: 'https://login.example.com', origin: 'http://localhost:5175' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/auth/login`)).status, 404);
    assert.equal((await fetch(`${base}/api/auth/complete`, { method: 'POST' })).status, 404);
    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: 'playparty_owner=forged' } })).json();
    assert.equal(session.owner, false); assert.equal(session.plexLogin, false);
    const host = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'playparty_owner=forged' }, body: JSON.stringify({ name: 'Owner', host: true }) });
    assert.equal(host.status, 403);
  } finally { await close(); }
});

test('one app address proxies LiveKit HTTP and WebSockets without forwarding login cookies', async () => {
  const upstream = http.createServer((req, res) => { res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie || null })); });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (socket, req) => { socket.send(JSON.stringify({ path: req.url, cookie: req.headers.cookie || null })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { server, close } = createApp({ plex: { streams: new Map(), stop: async () => {} }, authenticateOwner: async () => false, livekitInternalUrl: `http://127.0.0.1:${upstream.address().port}`, origin: 'http://localhost:5175' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/livekit/rtc/validate?test=1`, { headers: { Cookie: 'owner_session=private' } })).json(), { path: '/rtc/validate?test=1', cookie: null });
    const socket = new WebSocket(`${base.replace('http', 'ws')}/livekit/rtc?test=1`, { headers: { Cookie: 'owner_session=private', Origin: 'http://localhost:5175' } });
    const message = await new Promise((resolve, reject) => { socket.once('message', data => resolve(JSON.parse(data))); socket.once('error', reject); });
    assert.deepEqual(message, { path: '/rtc?test=1', cookie: null });
    socket.close();
  } finally { await close(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => upstream.close(resolve)); }
});

test('setup writes matching private call credentials and preserves existing configuration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'playparty-setup-test-'));
  const options = { publicUrl: 'http://localhost:5175', plexUrl: 'http://localhost:32400', token: 'test-plex-token', ownerEmail: 'owner@example.com' };
  try {
    writeConfiguration(directory, options);
    const env = fs.readFileSync(path.join(directory, '.env'), 'utf8');
    const secret = env.match(/LIVEKIT_API_SECRET="([a-f0-9]+)"/)[1];
    assert.equal(secret.length, 64);
    assert.match(env, /AUTH_MODE="plex"/);
    assert.match(env, /LIVEKIT_MANAGED="true"/);
    assert.ok(fs.readFileSync(path.join(directory, 'data/livekit.yaml'), 'utf8').includes(secret));
    for (const file of ['.env', 'data/livekit.yaml']) assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
    assert.throws(() => writeConfiguration(directory, options), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), env);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
