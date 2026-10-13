import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp } from '../server/index.mjs';
import { writeConfiguration } from '../deploy/setup.mjs';

test('external auth has no Plex sign-in routes and cannot trust a standalone cookie', async () => {
  const { server, close } = createApp({ plex: { canAccess: async () => true, streams: new Map(), stop: async () => {} }, authenticateOwner: async () => false, origin: 'http://localhost:5175' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/auth/login`)).status, 404);
    assert.equal((await fetch(`${base}/api/auth/complete`, { method: 'POST' })).status, 404);
    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: 'playparty_owner=forged' } })).json();
    assert.equal(session.canHost, false);
    for (const field of ['owner', 'plexLogin', 'loginUrl', 'loginLabel']) assert.equal(field in session, false);
    const host = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'playparty_owner=forged' }, body: JSON.stringify({ name: 'Host', host: true }) });
    assert.equal(host.status, 403);
  } finally { await close(); }
});

test('one app address proxies LiveKit HTTP and WebSockets without forwarding login cookies', async () => {
  const upstream = http.createServer((req, res) => { res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie || null })); });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (socket, req) => { socket.send(JSON.stringify({ path: req.url, cookie: req.headers.cookie || null })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { server, close } = createApp({ plex: { canAccess: async () => true, streams: new Map(), stop: async () => {} }, authenticateOwner: async () => false, livekitInternalUrl: `http://127.0.0.1:${upstream.address().port}`, origin: 'http://localhost:5175' });
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
  const options = { publicUrl: 'http://localhost:5175', plexUrl: 'http://localhost:32400', token: 'test-plex-token' };
  try {
    writeConfiguration(directory, options);
    const env = fs.readFileSync(path.join(directory, '.env'), 'utf8');
    const secret = env.match(/LIVEKIT_API_SECRET="([a-f0-9]+)"/)[1];
    assert.equal(secret.length, 64);
    assert.match(env, /AUTH_MODE="network"/);
    assert.equal(env.includes('PLEX_OWNER_EMAIL'), false);
    assert.match(env, /LIVEKIT_MANAGED="true"/);
    assert.ok(fs.readFileSync(path.join(directory, 'data/livekit.yaml'), 'utf8').includes(secret));
    for (const file of ['.env', 'data/livekit.yaml']) assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
    assert.throws(() => writeConfiguration(directory, options), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), env);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('setup preserves tokenless network access without writing an undefined credential', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'playparty-tokenless-setup-test-'));
  try {
    writeConfiguration(directory, { publicUrl: 'http://localhost:5175', plexUrl: 'http://localhost:32400' });
    const env = fs.readFileSync(path.join(directory, '.env'), 'utf8');
    assert.equal(env.includes('PLEX_TOKEN='), false);
    assert.equal(env.includes('undefined'), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
