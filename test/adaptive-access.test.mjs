import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.mjs';
import { MovieBudget } from '../server/bandwidth.mjs';

test('local owner and guests retain full quality while only connected remote viewers share the upload allowance', async () => {
  const starts = [];
  const upstream = [];
  const sockets = [];
  let budgetUses = 0;
  const originalLimiter = MovieBudget.prototype.limiter;
  MovieBudget.prototype.limiter = function () { budgetUses++; return originalLimiter.call(this); };
  const plex = {
    canAccess: async () => true,
    token: 'fixture-token', ownerName: 'Owner', streams: new Map(), resources: new Map(),
    async start(identity, movie, options) {
      starts.push({ identity, movie, options });
      const id = `stream-${identity}`;
      plex.streams.set(identity, { id, version: movie.version });
      plex.resources.set(identity, { streamId: id, target: '/fixture.ts' });
      return { url: `/api/stream/${identity}`, offset: 0, quality: 'Original video', subtitleMode: 'none' };
    },
    async stop(identity) { plex.streams.delete(identity); plex.resources.delete(identity); },
    async request(target, identity) {
      upstream.push({ target, identity });
      assert.equal(target, '/fixture.ts', 'Playback never writes Plex global preferences.');
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp2t' } });
    },
  };
  const { server, party, close } = createApp({ plex, authenticateOwner: async cookie => cookie?.includes('owner=test'),
    livekitKey: 'fixture-key', livekitSecret: 'test-only'.repeat(4), movieMbps: 70, recordProgress: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, member, body = {}, extraHeaders = {}) => fetch(`${base}/api/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: member?.cookie || '', ...extraHeaders }, body: JSON.stringify(body),
  });
  async function join(name, address, owner = false, connected = true) {
    const headers = { ...(owner ? { Cookie: 'owner=test' } : {}), ...(address ? { 'X-Forwarded-For': address } : {}) };
    const response = await request('join', null, { name, host: owner }, headers);
    assert.equal(response.status, 200);
    const body = await response.json();
    const member = { identity: body.identity, cookie: response.headers.get('set-cookie').split(';')[0] + (owner ? '; owner=test' : ''), address };
    if (connected) {
      const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/events`, { headers: { Cookie: member.cookie, ...(address ? { 'X-Forwarded-For': address } : {}) } });
      sockets.push(socket);
      await once(socket, 'open');
      assert.equal(party.members.get(member.identity).connected, true);
    }
    return member;
  }
  async function playback(member, body) {
    const response = await request('playback', member, body, member.address ? { 'X-Forwarded-For': member.address } : {});
    assert.equal(response.status, 200);
    return response.json();
  }
  try {
    const owner = await join('Owner', null, true);
    const localGuest = await join('Local guest', null);
    const remote = await join('Remote guest', '198.51.100.10');
    party.select({ id: '1', duration: 1200 });

    for (const member of [owner, localGuest]) {
      const result = await playback(member, { remote: true, maxBitrate: 1500 });
      assert.equal(result.remote, false);
      assert.equal(result.maxBitrate, 0);
      assert.equal(result.currentBitrate, 0);
      assert.equal(starts.at(-1).options.remote, false);
      assert.equal(starts.at(-1).options.maxBitrate, 0);
      assert.equal(starts.at(-1).options.adaptive, false);
      assert.equal((await fetch(base + result.url, { headers: { Cookie: member.cookie } })).status, 200);
    }
    assert.equal(budgetUses, 0, 'Local media responses consume no remote upload budget.');

    const full = await playback(remote, { remote: false, maxBitrate: 999999999 });
    assert.equal(full.remote, true, 'A request body cannot override the connection classification.');
    assert.equal(full.maxBitrate, 59500, 'Connected local seats do not divide the remote allowance.');
    assert.equal(full.currentBitrate, 59500);
    assert.equal(starts.at(-1).options.remote, true);
    assert.equal(starts.at(-1).options.maxBitrate, 59500);
    assert.equal(starts.at(-1).options.adaptive, false);
    assert.equal((await fetch(base + full.url, { headers: { Cookie: remote.cookie, 'X-Forwarded-For': remote.address } })).status, 200);
    assert.equal(budgetUses, 1, 'Remote media responses use the shared limiter.');

    const reduced = await playback(remote, { remote: false, maxBitrate: 4000, qualityReason: 'bandwidth', subtitleId: '9' });
    assert.equal(reduced.remote, true);
    assert.equal(reduced.maxBitrate, 59500);
    assert.equal(reduced.currentBitrate, 4000);
    assert.equal(reduced.mediaVersion, full.mediaVersion, 'A per-viewer quality change retains the selected movie version.');
    assert.equal(starts.at(-1).options.adaptive, true);
    assert.equal(starts.at(-1).options.subtitleId, '9');

    await join('Second remote guest', '198.51.100.11');
    await join('Disconnected remote guest', '198.51.100.12', false, false);
    const shared = await playback(remote, {});
    assert.equal(shared.maxBitrate, 29750, 'Only the two connected remote seats divide the 85% upload allowance.');
    assert.equal(shared.currentBitrate, 29750);
    assert.equal(starts.at(-1).options.maxBitrate, 29750);
    assert.equal(upstream.length, 3);
    assert.equal(upstream.every(row => row.target === '/fixture.ts'), true);
  } finally {
    for (const socket of sockets) socket.terminate();
    await close();
    MovieBudget.prototype.limiter = originalLimiter;
  }
});
