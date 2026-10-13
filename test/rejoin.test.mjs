import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.mjs';

test('expired memberships release cached readiness and stop their streams', async () => {
  const stopped = [];
  const plex = { canAccess: async () => true, streams: new Map(), stop: async id => { stopped.push(id); plex.streams.delete(id); } };
  const { server, party, sessions, close } = createApp({ plex, recordProgress: false, livekitKey: 'fixture-key', livekitSecret: 'test-only'.repeat(4) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const member = party.join('Expired viewer', false);
    sessions.set('expired-fixture', member);
    party.select({ id: 'fixture', duration: 120 });
    plex.streams.set(member.id, { id: 'expired-stream' });
    party.markReady(member.id, party.mediaVersion);
    member.lastSeen = Date.now() - 46000;
    await delay(2200);
    assert.equal(party.members.has(member.id), false);
    assert.equal(sessions.has('expired-fixture'), false);
    assert.equal(party.ready.has(member.id), false, 'Expiry must remove cached readiness as well as membership.');
    assert.deepEqual(stopped, [member.id]);
    assert.equal(party.movie, null);
    assert.equal(party.position, 0);
    assert.equal(party.wantsPlay, false);
    assert.equal(plex.streams.size, 0);
    const joined = await fetch(`http://127.0.0.1:${server.address().port}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New host', host: true }) });
    assert.equal(joined.status, 200);
    assert.equal((await joined.json()).state.movie, null, 'A fresh host starts without expired playback.');
  } finally { await close(); }
});

test('replacement sockets and leaving invalidate old readiness even when the room is manually paused', async () => {
  const plex = { canAccess: async () => true, streams: new Map(), stop: async () => {} };
  const sockets = [];
  const { server, party, close } = createApp({ plex, authenticateOwner: cookie => cookie?.includes('owner=test'),
    livekitKey: 'fixture-key', livekitSecret: 'test-only'.repeat(4), recordProgress: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, cookie, body) => fetch(`${base}/api/${route}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  async function join(name, cookie = '', host = false) {
    const response = await request('join', cookie, { name, host });
    assert.equal(response.status, 200);
    const member = await response.json();
    return { ...member, cookie: (response.headers.get('set-cookie')?.split(';')[0] || cookie.split(';')[0]) + (host ? '; owner=test' : '') };
  }
  async function connect(member) {
    const socket = new WebSocket(base.replace(/^http/, 'ws') + '/events', { headers: { Cookie: member.cookie } });
    sockets.push(socket); await once(socket, 'open'); return socket;
  }
  try {
    const owner = await join('Owner', 'owner=test', true);
    const guest = await join('Guest');
    const original = await connect(owner);
    await connect(guest);
    party.select({ id: '1', duration: 1200 });
    party.markReady(owner.identity, party.mediaVersion);
    party.markReady(guest.identity, party.mediaVersion);
    party.control('pause');
    assert.ok(party.ready.has(owner.identity) && party.ready.has(guest.identity));

    // Keep the original client from seeing the server close handshake so an
    // old in-flight ready message can arrive after its replacement connects.
    original._socket.pause();
    await connect(owner);
    assert.equal(party.ready.has(owner.identity), false, 'A replacement transport must prove current playback readiness.');
    original.send(JSON.stringify({ type: 'ready', mediaVersion: party.mediaVersion }));
    await delay(50);
    assert.equal(party.ready.has(owner.identity), false, 'A replaced socket cannot make its replacement ready.');
    original._socket.resume();

    assert.equal((await request('leave', guest.cookie, {})).status, 200);
    assert.equal(party.ready.has(guest.identity), false, 'Leaving removes readiness tied to the old player.');
    const returning = await join('Guest', guest.cookie);
    assert.equal(returning.identity, guest.identity);
    await connect(returning);
    party.control('play');
    party.markReady(owner.identity, party.mediaVersion);
    assert.ok(party.paused && party.wantsPlay, 'A returning guest cannot inherit readiness from before leaving.');
    party.markReady(returning.identity, party.mediaVersion);
    assert.equal(party.paused, false);
  } finally {
    for (const socket of sockets) socket.terminate();
    await close();
  }
});
