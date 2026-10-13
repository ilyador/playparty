import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/index.mjs';
import { ownerAuthenticator } from '../server/auth.mjs';
import { Plex } from '../server/plex.mjs';
import { WebSocket } from 'ws';

function hostFixture(overrides = {}) {
  return { canAccess: async () => true, streams: new Map(), resources: new Map(), stop: async () => {}, library: async () => [], ...overrides };
}

async function hostApp(plex, options = {}) {
  const app = createApp({ plex, recordProgress: false, livekitKey: 'fixture-key', livekitSecret: 'test-only'.repeat(4), ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}/api/`;
  return { ...app, request: (route, body, cookie = '') => fetch(url + route, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  }) };
}

test('configured Plex access enables hosting without identity checks, but only an explicit host choice grants controls', async () => {
  const { request, close } = await hostApp(hostFixture());
  try {
    const session = await (await request('session')).json();
    assert.equal(session.canHost, true);
    assert.deepEqual(Object.keys(session).sort(), ['canHost', 'state']);
    for (const body of [{ name: 'Guest' }, { name: 'Guest', owner: true }, { name: 'Guest', host: false }]) {
      const joined = await request('join', body);
      assert.equal(joined.status, 200);
      assert.equal((await joined.json()).owner, false);
      const cookie = joined.headers.get('set-cookie').split(';')[0];
      assert.equal((await request('library', undefined, cookie)).status, 403);
      assert.equal((await request('control', { action: 'play' }, cookie)).status, 403);
    }
    const joined = await request('join', { name: 'Host', host: true });
    assert.equal(joined.status, 200);
    assert.equal((await joined.json()).owner, true);
    const cookie = joined.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('library', undefined, cookie)).status, 200);
  } finally { await close(); }
});

test('unavailable Plex hides host eligibility and rejects host joins while guests remain able to join', async () => {
  let probes = 0;
  const { request, close } = await hostApp(hostFixture({ canAccess: async () => { probes++; return false; } }));
  try {
    assert.equal((await (await request('session')).json()).canHost, false);
    assert.equal((await (await request('health')).json()).plex, false);
    assert.equal(probes, 1, 'Session and health share the discovery result.');
    assert.equal((await request('join', { name: 'Host', host: true })).status, 403);
    assert.equal(probes, 2, 'A requested host join checks access again.');
    const guest = await request('join', { name: 'Guest' });
    assert.equal(guest.status, 200);
    assert.equal((await guest.json()).owner, false);
    assert.equal(probes, 2, 'Name-only joining does not require Plex availability.');
  } finally { await close(); }
});

test('Plex availability is checked again after discovery and before every privileged operation', async () => {
  let available = true;
  let images = 0;
  const { request, party, close } = await hostApp(hostFixture({ canAccess: async () => available,
    image: async () => { images++; return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/jpeg' } }); },
  }));
  try {
    assert.equal((await (await request('session')).json()).canHost, true);
    available = false;
    assert.equal((await request('join', { name: 'Host', host: true })).status, 403, 'A stale discovery result cannot authorize joining.');
    assert.equal((await (await request('health')).json()).plex, false);
    available = true;
    const joined = await request('join', { name: 'Host', host: true });
    const cookie = joined.headers.get('set-cookie').split(';')[0];
    party.select({ id: 'current', duration: 120 });
    available = false;
    for (const [route, body] of [['library'], ['select', { id: 'other' }], ['control', { action: 'play' }], ['stop', {}]]) {
      assert.equal((await request(route, body, cookie)).status, 403, `Lost Plex access denies ${route}.`);
    }
    assert.equal((await request('image/other', undefined, cookie)).status, 404);
    assert.equal(images, 0, 'Denied artwork requests do not fetch private library images.');
    assert.equal(party.movie.id, 'current');
    assert.equal((await request('image/current')).status, 200, 'Guests can still see artwork for the selected movie.');
  } finally { await close(); }
});

test('concurrent discovery and host actions share in-flight probes without reusing stale authorization', async () => {
  let calls = 0;
  let deferred = true;
  let finish;
  let arrival;
  let remaining = 0;
  const { request, server, close } = await hostApp(hostFixture({ canAccess: () => {
    calls++;
    if (!deferred) return true;
    return new Promise(resolve => { finish = resolve; });
  } }));
  server.on('request', () => { if (remaining && --remaining === 0) arrival(); });
  async function round(routes) {
    remaining = routes.length;
    const arrived = new Promise(resolve => { arrival = resolve; });
    const responses = routes.map(([route, body, cookie]) => request(route, body, cookie));
    await arrived;
    finish(true);
    return Promise.all(responses);
  }
  try {
    const discovered = await round(Array.from({ length: 8 }, (_, index) => [index % 2 ? 'health' : 'session']));
    assert.ok(discovered.every(response => response.status === 200));
    assert.equal(calls, 1);
    await request('session'); await request('health');
    assert.equal(calls, 1, 'Sequential discovery within five seconds reuses the result.');
    deferred = false;
    const joined = await request('join', { name: 'Host', host: true });
    const cookie = joined.headers.get('set-cookie').split(';')[0];
    assert.equal(calls, 2, 'Joining as host performs a fresh check.');
    deferred = true;
    const libraries = await round(Array.from({ length: 6 }, () => ['library', undefined, cookie]));
    assert.ok(libraries.every(response => response.status === 200));
    assert.equal(calls, 3, 'Concurrent host actions coalesce into a new access check.');
  } finally { finish?.(false); await close(); }
});

test('discovery expires after five seconds so a changed Plex server removes host eligibility', async t => {
  const originalNow = Date.now;
  const baseline = originalNow();
  let clock = baseline;
  let probes = 0;
  let available = true;
  t.mock.method(Date, 'now', () => clock);
  const { request, close } = await hostApp(hostFixture({ canAccess: async () => { probes++; return available; } }));
  try {
    assert.equal((await (await request('session')).json()).canHost, true);
    available = false;
    clock = baseline + 4999;
    assert.equal((await (await request('session')).json()).canHost, true);
    assert.equal(probes, 1);
    clock = baseline + 5000;
    assert.equal((await (await request('session')).json()).canHost, false);
    assert.equal(probes, 2);
  } finally { await close(); }
});

test('a departed member cannot complete a delayed Plex host check', async () => {
  let available = () => true;
  let began;
  let finish;
  let libraries = 0;
  const { request, close } = await hostApp(hostFixture({ canAccess: async () => available(), library: async () => { libraries++; return []; } }));
  try {
    const joined = await request('join', { name: 'Host', host: true });
    const cookie = joined.headers.get('set-cookie').split(';')[0];
    const probing = new Promise(resolve => { began = resolve; });
    available = () => { began(); return new Promise(resolve => { finish = resolve; }); };
    const library = request('library', undefined, cookie);
    await probing;
    assert.equal((await request('leave', {}, cookie)).status, 200);
    finish(true);
    assert.equal((await library).status, 403);
    assert.equal(libraries, 0, 'The removed member is checked again before accessing the library.');
  } finally { finish?.(false); await close(); }
});

test('a retired host cannot apply a movie selection whose Plex metadata arrives later', async t => {
  for (const retirement of ['leave', 'replacement']) {
    await t.test(retirement, async () => {
      let began;
      let finish;
      const metadataPending = new Promise(resolve => { began = resolve; });
      const { request, party, close } = await hostApp(hostFixture({
        metadata: async () => { began(); return new Promise(resolve => { finish = resolve; }); },
        simplify: item => item,
      }));
      try {
        const joined = await request('join', { name: 'First host', host: true });
        const cookie = joined.headers.get('set-cookie').split(';')[0];
        party.select({ id: 'original', duration: 120 });
        const selected = request('select', { id: 'late' }, cookie);
        await metadataPending;
        const retired = retirement === 'leave' ? await request('leave', {}, cookie) : await request('join', { name: 'New host', host: true });
        assert.equal(retired.status, 200);
        finish({ id: 'late', type: 'movie', duration: 120 });
        assert.equal((await selected).status, 401);
        assert.equal(party.movie.id, 'original', 'Late metadata cannot change playback after its host loses the session.');
      } finally { finish?.({ id: 'late', type: 'movie', duration: 120 }); await close(); }
    });
  }
});

test('external provider remains a separate authenticated gate and its revocation immediately removes host access', async () => {
  let authenticated = true;
  const provider = http.createServer((req, res) => {
    const valid = authenticated && req.headers.cookie === 'fixture_session=valid';
    res.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: valid }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const { request, close } = await hostApp(hostFixture(), { authenticateOwner: ownerAuthenticator(`http://127.0.0.1:${provider.address().port}/session`, ['fixture_session']) });
  try {
    assert.equal((await (await request('session')).json()).canHost, false);
    assert.equal((await request('join', { name: 'Host', host: true })).status, 403);
    assert.equal((await (await request('session', undefined, 'fixture_session=valid')).json()).canHost, true);
    const joined = await request('join', { name: 'Host', host: true }, 'fixture_session=valid');
    assert.equal(joined.status, 200, 'A valid provider session can host without any email.');
    const cookie = joined.headers.get('set-cookie').split(';')[0] + '; fixture_session=valid';
    assert.equal((await request('library', undefined, cookie)).status, 200);
    authenticated = false;
    assert.equal((await (await request('session', undefined, cookie)).json()).canHost, false);
    assert.equal((await request('library', undefined, cookie)).status, 403);
    assert.equal((await request('control', { action: 'play' }, cookie)).status, 403);
  } finally { await close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
});

test('host recognition delegates to an authenticated external session without matching email, preserving duplicate cookies', async () => {
  let receivedCookie;
  let email = 'unrelated@example.com';
  const server = http.createServer((req, res) => {
    receivedCookie = req.headers.cookie;
    const valid = receivedCookie?.includes('owner_session=current');
    res.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(valid ? { authenticated: true, ...(email ? { email } : {}) } : { authenticated: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/auth/session`;
  try {
    const valid = ownerAuthenticator(url);
    assert.equal(await valid('owner_session=current; playparty_session=private'), true);
    assert.equal(receivedCookie, 'owner_session=current');
    assert.equal(await valid('owner_session=stale; owner_session=current'), true);
    assert.equal(receivedCookie, 'owner_session=stale; owner_session=current');
    assert.equal(await valid('owner_session=forged'), false);
    email = undefined;
    assert.equal(await valid('owner_session=current'), true, 'A provider need not return any email.');
    assert.equal(await valid(''), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('name-only guests cannot forge host status, browse the library, or control playback', async () => {
  const plex = { canAccess: async () => true, ownerName: 'Owner', streams: new Map(), resources: new Map(), stop: async () => {}, library: async () => [{ id: '1' }], token: 'test' };
  const { server, party } = createApp({ plex, authenticateOwner: async header => header?.includes('owner=test'), livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters', origin: 'http://localhost:5175' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/`;
  const request = (route, options = {}) => fetch(url + route, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  try {
    const joined = await request('join', { method: 'POST', body: JSON.stringify({ name: 'Owner', owner: true }) });
    const cookie = joined.headers.get('set-cookie').split(';')[0];
    const body = await joined.json();
    assert.equal(body.owner, false);
    assert.notEqual(body.identity, 'owner');
    assert.equal((await request('library', { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await request('select', { method: 'POST', body: '{"id":"1"}', headers: { Cookie: cookie } })).status, 403);
    assert.equal((await request('control', { method: 'POST', body: '{"action":"play"}', headers: { Cookie: cookie } })).status, 403);
    assert.equal((await request('stop', { method: 'POST', body: '{}', headers: { Cookie: cookie } })).status, 403);
    assert.equal((await request('join', { method: 'POST', body: '{"name":"Fake host","host":true}', headers: { Cookie: cookie } })).status, 403);
    const owner = await request('join', { method: 'POST', body: '{"name":"Host","host":true}', headers: { Cookie: 'owner=test' } });
    const ownerBody = await owner.json();
    assert.equal(ownerBody.owner, true);
    const ownerCookie = owner.headers.get('set-cookie').split(';')[0] + '; owner=test';
    assert.equal((await request('library', { headers: { Cookie: ownerCookie } })).status, 200);
    const asGuest = await request('join', { method: 'POST', body: '{"name":"Host as guest","host":false}', headers: { Cookie: ownerCookie } });
    const guestBody = await asGuest.json();
    assert.equal(guestBody.owner, false);
    assert.equal(party.members.has('owner'), false);
    assert.equal((await request('library', { headers: { Cookie: ownerCookie } })).status, 403);
    const asHost = await request('join', { method: 'POST', body: '{"name":"Host","host":true}', headers: { Cookie: ownerCookie } });
    assert.equal((await asHost.json()).owner, true);
    assert.equal(party.members.has(guestBody.identity), false);
    assert.equal((await request('join', { method: 'POST', body: '{"name":"Guest"}', headers: { Origin: 'https://unrelated.example' } })).status, 403);
    assert.equal((await request('stream/unknown', { headers: { Cookie: cookie } })).status, 404);
    for (let i = 0; i < 6; i++) {
      const guest = await request('join', { method: 'POST', body: JSON.stringify({ name: `Guest ${i}` }) });
      assert.equal(guest.status, 200);
      assert.equal((await guest.json()).owner, false);
    }
    assert.equal(party.members.size, 8);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('public guest identities cannot be used as participant session cookies', async () => {
  const plex = { canAccess: async () => true, streams: new Map(), resources: new Map(), stop: async () => {} };
  const { server, party, close } = createApp({ plex, authenticateOwner: async () => false,
    livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters', recordProgress: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let socket;
  try {
    const joined = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Guest"}' });
    const cookie = joined.headers.get('set-cookie').split(';')[0];
    const member = await joined.json();
    socket = new WebSocket(base.replace(/^http/, 'ws') + '/events', { headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const session = await (await fetch(`${base}/api/session`)).json();
    assert.equal(session.state.participants[0].id, member.identity);
    assert.notEqual(member.identity, cookie.slice('playparty_session='.length));
    const forgedLeave = await fetch(`${base}/api/leave`, { method: 'POST', headers: { Cookie: `playparty_session=${member.identity}` } });
    assert.equal(forgedLeave.status, 401);
    assert.ok(party.members.has(member.identity));
    assert.equal(socket.readyState, WebSocket.OPEN);
  } finally { socket?.terminate(); await close(); }
});

test('an owner switching browsers retires the old participant session', async () => {
  const plex = { canAccess: async () => true, streams: new Map(), stop: async () => {}, library: async () => [] };
  const { server, sessions, party, close } = createApp({ plex, authenticateOwner: cookie => cookie?.includes('owner=test'),
    livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters', recordProgress: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  async function join() {
    const response = await fetch(`${base}/api/join`, { method: 'POST', headers: { Cookie: 'owner=test', 'Content-Type': 'application/json' }, body: '{"name":"Host","host":true}' });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0] + '; owner=test';
  }
  async function connect(cookie) {
    const socket = new WebSocket(base.replace(/^http/, 'ws') + '/events', { headers: { Cookie: cookie } });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return socket;
  }
  try {
    const firstCookie = await join();
    await connect(firstCookie);
    const oldMember = [...sessions.values()][0];
    const secondCookie = await join();
    let current = await connect(secondCookie);
    const currentClosed = new Promise(resolve => current.once('close', resolve));
    party.ready.add('owner');
    const repeatedJoin = await fetch(`${base}/api/join`, { method: 'POST', headers: { Cookie: secondCookie, 'Content-Type': 'application/json' }, body: '{"name":"Host","host":true}' });
    assert.equal(repeatedJoin.status, 200);
    assert.equal(party.members.get('owner').connected, false);
    assert.equal(party.ready.has('owner'), false);
    await currentClosed;
    current = await connect(secondCookie);
    oldMember.lastSeen = Date.now() - 91000;
    assert.equal(sessions.size, 1);
    assert.equal((await fetch(`${base}/api/library`, { headers: { Cookie: firstCookie } })).status, 401);
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.ok(party.members.get('owner')?.connected);
    assert.equal(current.readyState, WebSocket.OPEN);
    assert.equal((await fetch(`${base}/api/library`, { headers: { Cookie: secondCookie } })).status, 200);
  } finally { for (const socket of sockets) socket.terminate(); await close(); }
});

test('same-cookie rejoins and duplicate state sockets explicitly supersede the old tab', async () => {
  const plex = { canAccess: async () => true, streams: new Map(), stop: async () => {} };
  const { server, party, close } = createApp({ plex, authenticateOwner: async () => false,
    livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters', recordProgress: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, sockets = [];
  let cookie;
  const join = () => fetch(`${base}/api/join`, { method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: '{"name":"Guest"}' });
  const connect = async () => {
    const socket = new WebSocket(base.replace(/^http/, 'ws') + '/events', { headers: { Cookie: cookie } });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return socket;
  };
  const closed = socket => new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  try {
    const first = await join(); cookie = first.headers.get('set-cookie').split(';')[0];
    const identity = (await first.json()).identity;
    const firstSocket = await connect(), firstClosed = closed(firstSocket);
    assert.equal((await join()).status, 200);
    assert.deepEqual(await firstClosed, { code: 4001, reason: 'Joined in another tab' });
    const secondSocket = await connect(), secondClosed = closed(secondSocket);
    const thirdSocket = await connect();
    assert.deepEqual(await secondClosed, { code: 4001, reason: 'Joined in another tab' });
    assert.equal(thirdSocket.readyState, WebSocket.OPEN);
    assert.equal(party.members.size, 1);
    assert.ok(party.members.get(identity)?.connected, 'Closing an old tab cannot disconnect its replacement.');
  } finally { for (const socket of sockets) socket.terminate(); await close(); }
});

test('expired party sockets terminate explicitly and invalid sessions receive no party data', async () => {
  const plex = { canAccess: async () => true, streams: new Map(), stop: async () => {} };
  const { server, sessions, party, close } = createApp({ plex, authenticateOwner: async () => false,
    livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters', livekitInternalUrl: 'http://127.0.0.1:1', recordProgress: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, sockets = [];
  const connect = cookie => {
    const socket = new WebSocket(base.replace(/^http/, 'ws') + '/events', { headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: 'http://localhost:5175' } });
    sockets.push(socket);
    const messages = [];
    const firstState = new Promise(resolve => socket.on('message', data => { messages.push(data.toString()); resolve(); }));
    const closed = new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    const opened = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return { socket, messages, firstState, closed, opened };
  };
  try {
    const response = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Guest"}' });
    const cookie = response.headers.get('set-cookie').split(';')[0], member = await response.json();
    const current = connect(cookie); await current.opened; await current.firstState;
    party.ready.add(member.identity);
    party.members.get(member.identity).lastSeen = Date.now() - 91000;
    assert.deepEqual(await current.closed, { code: 4002, reason: 'Session expired' });
    assert.equal(party.members.has(member.identity), false);
    assert.equal(party.ready.has(member.identity), false);
    assert.equal(sessions.size, 0);
    const continuing = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Continuing viewer"}' });
    const validCookie = continuing.headers.get('set-cookie').split(';')[0], validMember = await continuing.json();
    const valid = connect(validCookie); await valid.opened; await valid.firstState;
    party.select({ id: 'private-movie', title: 'Private movie', duration: 120 });
    for (const invalid of [cookie, `playparty_session=${member.identity}`, 'playparty_session=unknown', undefined]) {
      const waking = connect(invalid); await waking.opened;
      assert.deepEqual(await waking.closed, { code: 4002, reason: 'Session expired' });
      assert.deepEqual(waking.messages, [], 'The terminal handshake must not reveal movie, playback, participant, or authentication data.');
      assert.equal(party.members.size, 1, 'An invalid WebSocket cannot recreate an expired member.');
      assert.ok(party.members.get(validMember.identity)?.connected, 'Rejected sessions cannot evict an active viewer.');
    }
    const crossOrigin = new WebSocket(base.replace(/^http/, 'ws') + '/events', { headers: { Cookie: validCookie, Origin: 'https://unrelated.example' } });
    sockets.push(crossOrigin);
    const leaked = []; crossOrigin.on('message', data => leaked.push(data.toString()));
    await assert.rejects(new Promise((resolve, reject) => { crossOrigin.once('open', resolve); crossOrigin.once('error', reject); }));
    assert.deepEqual(leaked, [], 'An unrelated origin must still be rejected before the WebSocket handshake.');
  } finally { for (const socket of sockets) socket.terminate(); await close(); }
});

test('leaving cancels waiting and in-flight streams before a returning participant starts another', async () => {
  let finishOld;
  let announceStart;
  const oldStarted = new Promise(resolve => { announceStart = resolve; });
  let starts = 0;
  const plex = { canAccess: async () => true, streams: new Map(), stop: async id => { plex.streams.delete(id); }, start: async (id, movie) => {
    const number = ++starts;
    if (number === 1) { announceStart(); await new Promise(resolve => { finishOld = resolve; }); }
    plex.streams.set(id, { id: `stream-${number}`, version: movie.version });
    return { url: `/api/stream/stream-${number}` };
  } };
  const { server, party, close } = createApp({ plex, authenticateOwner: async () => false,
    livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters', recordProgress: false });
  let playbackRequests = 0;
  let announceQueued;
  const queuedAccepted = new Promise(resolve => { announceQueued = resolve; });
  server.prependListener('request', req => {
    if (req.url === '/api/playback' && ++playbackRequests === 2) req.once('end', () => setImmediate(announceQueued));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = (route, body = {}) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const joined = await request('join', { name: 'Guest' });
    cookie = joined.headers.get('set-cookie').split(';')[0];
    const first = await joined.json();
    party.select({ id: '1', duration: 120 });
    const oldPlayback = request('playback');
    await oldStarted;
    const queuedPlayback = request('playback');
    await queuedAccepted;
    assert.equal((await request('leave')).status, 200);
    assert.equal(plex.streams.size, 0);
    const returning = await (await request('join', { name: 'Guest' })).json();
    assert.equal(returning.identity, first.identity);
    const newPlayback = request('playback');
    finishOld();
    assert.equal((await oldPlayback).status, 401);
    assert.equal((await queuedPlayback).status, 401);
    assert.equal((await newPlayback).status, 200);
    assert.equal(starts, 2);
    assert.equal(plex.streams.get(first.identity)?.id, 'stream-2');
  } finally { finishOld?.(); await close(); }
});

test('shutdown drains a pending stream and invalidates deferred joins and selections', async () => {
  let finishStart, finishMetadata, finishAuth;
  let announceStart, announceMetadata, announceAuth;
  const started = new Promise(resolve => { announceStart = resolve; });
  const selecting = new Promise(resolve => { announceMetadata = resolve; });
  const authenticating = new Promise(resolve => { announceAuth = resolve; });
  const progress = [];
  const plex = { canAccess: async () => true, streams: new Map(), stop: async id => { plex.streams.delete(id); },
    metadata: async () => { announceMetadata(); return new Promise(resolve => { finishMetadata = resolve; }); },
    simplify: item => item,
    start: async (id, movie) => { announceStart(); await new Promise(resolve => { finishStart = resolve; }); plex.streams.set(id, { id: 'pending-stream', version: movie.version }); return { url: '/api/stream/pending-stream' }; },
    timeline: async (movie, position, state) => { progress.push({ id: movie.id, position, state }); },
  };
  const { server, party, sessions, close } = createApp({ plex, authenticateOwner: async cookie => {
    if (cookie?.includes('owner=deferred')) { announceAuth(); await new Promise(resolve => { finishAuth = resolve; }); }
    return true;
  }, livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, cookie, body) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  try {
    const joined = await request('join', 'owner=test', { name: 'Host', host: true });
    const cookie = joined.headers.get('set-cookie').split(';')[0] + '; owner=test';
    party.select({ id: '1', duration: 120, resumePosition: 23 });
    const playback = request('playback', cookie, {});
    const selection = request('select', cookie, { id: '2' });
    const lateJoin = request('join', 'owner=deferred', { name: 'Late host', host: true });
    await Promise.all([started, selecting, authenticating]);
    let closed = false;
    const shutdown = close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'Shutdown must wait for an in-flight stream to be reclaimed.');
    finishStart();
    await shutdown;
    assert.equal(plex.streams.size, 0);
    assert.equal(sessions.size, 0);
    assert.deepEqual(progress, [{ id: '1', position: 23, state: 'stopped' }]);
    finishMetadata({ id: '2', type: 'movie', duration: 120 });
    finishAuth();
    await Promise.all([playback, selection, lateJoin]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(party.movie.id, '1');
    assert.equal(party.members.size, 1);
    assert.equal(sessions.size, 0);
  } finally { finishStart?.(); finishMetadata?.({ id: '2', type: 'movie' }); finishAuth?.(); await close(); }
});

test('stop cancels an in-flight selection and invalidates an in-flight stream', async () => {
  let finishMetadata, finishPlayback;
  const stopped = [];
  const plex = { canAccess: async () => true,
    streams: new Map(), token: 'test', ownerName: 'Owner',
    metadata: () => new Promise(resolve => { finishMetadata = resolve; }),
    simplify: item => item,
    start: async (id, movie) => {
      plex.streams.set(id, { version: movie.version });
      await new Promise(resolve => { finishPlayback = resolve; });
      return { url: '/api/stream/test' };
    },
    stop: async id => { stopped.push(id); plex.streams.delete(id); },
  };
  const { server, party } = createApp({ plex, authenticateOwner: async () => true, livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  let cookie = '';
  const request = (path, body) => fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const until = async check => { for (let i = 0; !check() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  try {
    const joined = await request('join', { name: 'Host', host: true });
    cookie = joined.headers.get('set-cookie').split(';')[0];
    const selection = request('select', { id: '1' });
    await until(() => finishMetadata);
    assert.equal((await request('stop', {})).status, 200);
    finishMetadata({ id: '1', type: 'movie', duration: 120 });
    assert.equal((await selection).status, 409);
    assert.equal(party.movie, null);
    party.select({ id: '1', duration: 120 });
    const playing = request('playback', {});
    await until(() => finishPlayback);
    const members = party.members.size;
    const stop = await request('stop', {});
    assert.equal((await stop.json()).movie, null);
    finishPlayback();
    assert.equal((await playing).status, 409);
    assert.equal(party.members.size, members);
    assert.equal(plex.streams.size, 0);
    assert.ok(stopped.includes('owner'));
  } finally {
    finishPlayback?.();
    finishMetadata?.({ id: '1', type: 'movie', duration: 120 });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('subtitle choices belong to the selected media and use text renditions or image burning', async () => {
  const plex = new Plex({ token: 'test-token' });
  const item = { ratingKey: '7', type: 'episode', title: 'Episode title', grandparentTitle: 'Series name', parentIndex: 2, index: 3,
    Media: [{ Part: [{ key: '/private/file', Stream: [
      { id: 11, streamType: 3, codec: 'srt', language: 'English', key: '/private/subtitle' },
      { id: 12, streamType: 3, codec: 'pgs', displayTitle: 'English Forced', title: 'Signs' },
    ] }] }] };
  const publicItem = plex.simplify(item);
  assert.equal(publicItem.seriesTitle, 'Series name');
  assert.equal(publicItem.episodeNumber, 'S2 E3');
  assert.equal(JSON.stringify(publicItem).includes('/private'), false);
  plex.metadata = async () => item;
  plex.stop = async () => {};
  let params;
  plex.json = async path => {
    params = new URL(path, plex.url).searchParams;
    return { Metadata: [{ Media: [{ Part: [{ Stream: [{ streamType: 1, decision: 'copy' }] }] }] }] };
  };
  const movie = { id: '7', version: 1 };
  assert.equal((await plex.start('guest', movie, { subtitleId: '11' })).subtitleMode, 'segmented');
  assert.equal(params.get('subtitleStreamID'), '11');
  assert.equal(params.get('subtitles'), 'segmented');
  assert.match(params.get('X-Plex-Client-Profile-Extra'), /subtitleCodec=webvtt/);
  assert.equal((await plex.start('guest', movie, { subtitleId: '12' })).subtitleMode, 'burn');
  assert.equal(params.get('subtitles'), 'burn');
  assert.equal((await plex.start('guest', movie)).subtitleMode, 'none');
  assert.equal(params.get('subtitles'), 'none');
  assert.equal(params.has('subtitleStreamID'), false);
  await assert.rejects(plex.start('guest', movie, { subtitleId: '999' }), { status: 400 });
});

test('Plex playlists hide credentials, reject other origins, and reuse resource identifiers', () => {
  const plex = new Plex({ token: 'secret-token' });
  const stream = { id: 'stream', resourceIds: new Set(), targets: new Map() };
  const manifest = '#EXTM3U\n#EXT-X-MAP:URI="header?X-Plex-Token=secret-token"\n00000.ts\n';
  const first = plex.rewritePlaylist(manifest, new URL('http://127.0.0.1:32400/session/base/index.m3u8'), stream);
  assert.equal(first.includes('secret-token'), false);
  assert.equal(first.includes('32400'), false);
  assert.equal(plex.rewritePlaylist(manifest, new URL('http://127.0.0.1:32400/session/base/index.m3u8'), stream), first);
  assert.equal(plex.resources.size, 2);
  assert.throws(() => plex.addResource(stream, 'http://other.example/secret'));
});

test('host controls save ordered progress to Plex before Stop returns', async () => {
  const updates = [];
  const plex = { canAccess: async () => true, token: 'test', streams: new Map(), stop: async () => {},
    metadata: async id => ({ id, type: 'episode', duration: 1200, resumePosition: 87 }),
    simplify: item => item,
    timeline: async (movie, position, state, session) => { updates.push({ id: movie.id, position, state, session }); },
  };
  const { server, close } = createApp({ plex, authenticateOwner: async () => true, livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  let cookie = '';
  const request = (path, body) => fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const joined = await request('join', { name: 'Host', host: true });
    cookie = joined.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await request('select', { id: '7' })).json()).position, 87);
    await request('control', { action: 'seek', position: 123 });
    await request('control', { action: 'pause' });
    const stopped = await request('stop', {});
    assert.equal((await stopped.json()).movie, null);
    assert.equal(updates.length, 3);
    assert.deepEqual(updates.map(({ position, state }) => ({ position, state })), [
      { position: 123, state: 'paused' }, { position: 123, state: 'paused' }, { position: 123, state: 'stopped' },
    ]);
    assert.equal(new Set(updates.map(update => update.session)).size, 1);
    assert.ok(updates.every(update => update.id === '7'));
    const socket = new WebSocket(base.replace(/^http/, 'ws').replace('/api/', '/events'), { headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const disconnected = new Promise(resolve => socket.once('close', resolve));
    await close();
    await disconnected;
  } finally { if (server.listening) await close(); }
});

test('recovery diagnostics survive nearby samples while duplicate and burst logging stays bounded', async () => {
  const logged = [];
  const plex = { canAccess: async () => true, streams: new Map(), resources: new Map(), stop: async () => {} };
  const { server, close } = createApp({ plex, authenticateOwner: async () => false,
    livekitKey: 'key', livekitSecret: 'test-secret-at-least-32-characters', recordProgress: false, logPlayback: sample => logged.push(sample) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let socket;
  try {
    const joined = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Guest"}' });
    const cookie = joined.headers.get('set-cookie').split(';')[0];
    socket = new WebSocket(base.replace(/^http/, 'ws') + '/events', { headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const processed = new Promise(resolve => socket.on('message', raw => { if (JSON.parse(raw).type === 'pong') resolve(); }));
    const sample = event => socket.send(JSON.stringify({ type: 'telemetry', event }));
    sample('sample');
    for (const event of ['seek-recovery', 'sync-recovery', 'state-stale']) { sample(event); sample(event); }
    for (let drift = 0; drift < 40; drift++) socket.send(JSON.stringify({ type: 'telemetry', event: 'sync-recovery', drift }));
    socket.send(JSON.stringify({ type: 'ping', sent: 0 }));
    await processed;
    assert.equal(logged.filter(sample => sample.event === 'sample').length, 1);
    for (const event of ['seek-recovery', 'state-stale']) assert.equal(logged.filter(sample => sample.event === event).length, 1);
    assert.equal(logged.filter(sample => sample.event === 'sync-recovery' && sample.drift === undefined).length, 1);
    assert.equal(logged.filter(sample => ['seek-recovery', 'sync-recovery', 'state-stale'].includes(sample.event)).length, 12);
  } finally { socket?.terminate(); await close(); }
});

test('Plex timeline reports use milliseconds and continue watching handles hub responses', async () => {
  let received;
  const server = http.createServer((req, res) => {
    received = { method: req.method, url: new URL(req.url, 'http://localhost'), session: req.headers['x-plex-session-identifier'] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const plex = new Plex({ url: `http://127.0.0.1:${server.address().port}`, token: 'test-token' });
    await plex.timeline({ id: '7', duration: 120 }, 12.345, 'paused', 'playback-session');
    assert.equal(received.method, 'POST');
    assert.equal(received.url.pathname, '/:/timeline');
    assert.equal(received.url.searchParams.get('time'), '12345');
    assert.equal(received.url.searchParams.get('duration'), '120000');
    assert.equal(received.session, 'playback-session');
    plex.json = async () => ({ Hub: [{ Metadata: [{ ratingKey: '7', type: 'episode', title: 'Episode', grandparentTitle: 'Series', parentIndex: 2, index: 3, viewOffset: 12345, lastViewedAt: 1000 }] }] });
    const [item] = await plex.continueWatching();
    assert.equal(item.resumePosition, 12.345);
    assert.equal(item.lastPlayedAt, 1000);
    assert.equal(item.episodeDetails, 'Season 2 · Episode 3');
    plex.json = async path => path === '/library/sections' ? { Directory: [{ key: '2', type: 'show' }] } : path.startsWith('/library/sections/2/all')
      ? { Metadata: [{ ratingKey: '8', type: 'episode', title: 'Recently started', viewOffset: 1000, lastViewedAt: 2000 }] }
      : { Hub: [{ Metadata: [{ ratingKey: '7', type: 'episode', title: 'Older progress', viewOffset: 12000, lastViewedAt: 1000 }] }] };
    const continued = await plex.continueWatching();
    assert.deepEqual(continued.map(item => item.id), ['8', '7']);
    assert.equal(continued[0].resumePosition, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
