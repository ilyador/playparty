import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), message);
}

async function fixture(t, overrides = {}) {
  const removals = [], deletions = [], sockets = [], started = [], stopped = [];
  let removalGate, deletionGate;
  const callServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url.endsWith('/RemoveParticipant')) {
      removals.push(JSON.parse(raw));
      if (removalGate) await removalGate.promise;
    } else if (req.url.endsWith('/DeleteRoom')) {
      deletions.push(JSON.parse(raw));
      if (deletionGate) await deletionGate.promise;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => callServer.listen(0, '127.0.0.1', resolve));
  const plex = {
    canAccess: async () => true, streams: new Map(), resources: new Map(),
    async metadata(id) { return { id, type: 'movie', duration: 600 }; },
    simplify: movie => movie,
    async start(id, movie) {
      started.push({ id, movie });
      plex.streams.set(id, { id: `stream-${movie.id}`, version: movie.version });
      return { url: '/api/stream/fixture', offset: 0 };
    },
    async stop(id) { stopped.push(id); plex.streams.delete(id); },
    ...overrides,
  };
  const app = createApp({ plex, livekitKey: 'fixture-key', livekitSecret: 'fixture-secret-at-least-32-characters',
    livekitInternalUrl: `http://127.0.0.1:${callServer.address().port}`, recordProgress: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, cookie = '', body) => fetch(`${base}/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function join(name, cookie = '', connected = true, host = true) {
    const response = await request('join', cookie, { name, host });
    assert.equal(response.status, 200);
    const data = await response.json();
    const sid = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    let socket;
    if (connected) {
      socket = new WebSocket(base.replace(/^http/, 'ws') + '/events', { headers: { Cookie: sid } });
      sockets.push(socket);
      await once(socket, 'open');
      await until(() => app.party.members.get(data.identity)?.connected, 'The participant must really connect.');
    }
    return { data, cookie: sid, socket };
  }
  t.after(async () => {
    removalGate?.resolve();
    deletionGate?.resolve();
    for (const socket of sockets) socket.terminate();
    await app.close();
    callServer.closeAllConnections();
    await new Promise(resolve => callServer.close(resolve));
  });
  return { ...app, plex, request, join, removals, deletions, started, stopped,
    holdRemoval() { removalGate = deferred(); return removalGate; },
    holdDeletion() { deletionGate = deferred(); return deletionGate; },
  };
}

test('the last explicit departure resets playback and waits for old call eviction before admitting a fresh host', async t => {
  const f = await fixture(t);
  const first = await f.join('Original host');
  assert.equal((await f.request('select', first.cookie, { id: 'old' })).status, 200);
  assert.equal((await f.request('playback', first.cookie, {})).status, 200);
  const oldVersion = f.party.mediaVersion;
  const removal = f.holdRemoval();
  const deletion = f.holdDeletion();
  const leaving = f.request('leave', first.cookie, {});
  await until(() => f.removals.length === 1, 'The old call participant must actually reach the SDK eviction request.');
  assert.equal(f.party.movie, null, 'Empty-room retirement must clear the selected movie before admission resumes.');
  assert.equal(f.party.members.size, 0);
  assert.equal(f.party.ready.size, 0);
  assert.equal(f.party.wantsPlay, false);
  assert.equal(f.sessions.size, 0);
  assert.ok(f.party.mediaVersion > oldVersion, 'Retirement must invalidate old media responses.');
  assert.equal(f.plex.streams.size, 0);
  let admitted = false;
  const next = f.join('New host').then(value => { admitted = true; return value; });
  await delay(100);
  assert.equal(admitted, false, 'New ownership must wait for the previous identity’s delayed LiveKit removal.');
  assert.equal(f.party.members.size, 0, 'A replacement cannot enter the old call-cleanup window.');
  removal.resolve();
  await until(() => f.deletions.length === 1, 'Empty retirement must reclaim the old call room.');
  await delay(100);
  assert.equal(admitted, false, 'A delayed old room deletion cannot run after the new host creates its call.');
  deletion.resolve();
  assert.equal((await leaving).status, 200);
  const replacement = await next;
  assert.equal((await f.request('select', replacement.cookie, { id: 'new' })).status, 200);
  assert.equal((await f.request('playback', replacement.cookie, {})).status, 200);
  assert.equal((await f.request('control', first.cookie, { action: 'pause' })).status, 401);
  await delay(50);
  assert.equal(f.plex.streams.get('owner')?.id, 'stream-new', 'Finishing stale cleanup cannot stop the new host’s stream.');
  assert.equal(f.removals.length, 1, 'The retired owner must be evicted only once.');
});

test('real member expiry uses the same retirement barrier and makes the stale owner session unusable', async t => {
  const f = await fixture(t);
  const first = await f.join('Expiring host');
  assert.equal((await f.request('select', first.cookie, { id: 'old' })).status, 200);
  assert.equal((await f.request('playback', first.cookie, {})).status, 200);
  const removal = f.holdRemoval();
  const closed = once(first.socket, 'close');
  f.party.members.get('owner').lastSeen = Date.now() - 95000;
  await until(() => f.removals.length === 1, 'The actual membership ticker must begin old call eviction.');
  assert.equal((await closed)[0], 4002);
  assert.equal(f.party.movie, null);
  assert.equal(f.sessions.size, 0);
  assert.equal(f.plex.streams.size, 0);
  let admitted = false;
  const next = f.join('After expiry').then(value => { admitted = true; return value; });
  await delay(100);
  assert.equal(admitted, false, 'A ticker-triggered cleanup must block new identity reuse until its call eviction settles.');
  removal.resolve();
  const replacement = await next;
  assert.equal((await f.request('playback', first.cookie, {})).status, 401);
  assert.equal((await f.request('select', replacement.cookie, { id: 'new' })).status, 200);
  assert.equal((await f.request('playback', replacement.cookie, {})).status, 200);
  await delay(50);
  assert.equal(f.plex.streams.get('owner')?.id, 'stream-new');
  assert.equal(f.party.members.get('owner').connected, true);
});

test('claiming a disconnected empty room drains an in-flight transcode and rejects its delayed old selection', async t => {
  const startGate = deferred(), metadataGate = deferred();
  let oldStart, oldMetadata, f;
  t.after(() => { startGate.resolve(); metadataGate.resolve(); });
  f = await fixture(t, {
    async metadata(id) {
      if (id === 'late-old') { oldMetadata = true; await metadataGate.promise; }
      return { id, type: 'movie', duration: 600 };
    },
    async start(id, movie) {
      if (movie.id === 'old') { oldStart = true; await startGate.promise; }
      f.plex.streams.set(id, { id: `stream-${movie.id}`, version: movie.version });
      return { url: '/api/stream/fixture', offset: 0 };
    },
  });
  const first = await f.join('Never connected host', '', false);
  assert.equal((await f.request('select', first.cookie, { id: 'old' })).status, 200);
  const oldPlayback = f.request('playback', first.cookie, {});
  const oldSelection = f.request('select', first.cookie, { id: 'late-old' });
  await until(() => oldStart && oldMetadata, 'Both old asynchronous operations must genuinely be in flight.');
  let admitted = false;
  const next = f.join('Fresh host').then(value => { admitted = true; return value; });
  await delay(100);
  assert.equal(admitted, false, 'A new host must not share its identity with the pending old transcode.');
  assert.equal(f.party.movie, null, 'An empty room is reset as soon as ownership is retired.');
  startGate.resolve();
  const replacement = await next;
  assert.equal((await oldPlayback).status, 401);
  assert.equal(f.plex.streams.size, 0, 'The old transcode must be reclaimed before new playback is admitted.');
  assert.equal((await f.request('select', replacement.cookie, { id: 'new' })).status, 200);
  assert.equal((await f.request('playback', replacement.cookie, {})).status, 200);
  metadataGate.resolve();
  assert.equal((await oldSelection).status, 401);
  assert.equal(f.party.movie.id, 'new', 'Finishing the old metadata request cannot resurrect its retired selection.');
  assert.equal(f.plex.streams.get('owner')?.id, 'stream-new');
  assert.equal(f.removals.length, 1);
});

test('an old join whose call token is still being signed cannot return usable owner credentials after empty-room retirement', async t => {
  const signing = deferred(), started = deferred();
  const sign = AccessToken.prototype.toJwt;
  AccessToken.prototype.toJwt = async function () {
    if (this.name === 'Retired before signing') { started.resolve(); await signing.promise; }
    return sign.call(this);
  };
  t.after(() => { signing.resolve(); AccessToken.prototype.toJwt = sign; });
  const f = await fixture(t);
  const oldJoin = f.request('join', '', { name: 'Retired before signing', host: true });
  await started.promise;
  assert.equal(f.party.members.get('owner').connected, false);
  const replacement = await f.join('Current host');
  assert.ok(replacement.data.token, 'The current member must obtain a real signed call token.');
  signing.resolve();
  const retired = await oldJoin;
  assert.equal(retired.status, 409, 'A completed stale signing operation must not return an owner JWT that can evict the new call participant.');
  assert.equal(Object.hasOwn(await retired.json(), 'token'), false);
  assert.equal(f.party.members.get('owner').name, 'Current host');
  assert.equal(f.party.members.get('owner').connected, true);
  assert.equal(f.removals.length, 1);
});
