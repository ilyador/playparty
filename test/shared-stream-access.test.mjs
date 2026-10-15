import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const bodyAborted = async reader => {
  try { while (!(await reader.read()).done) {} return false; } catch { return true; }
};
const within = async (promise, message = 'The retired HTTP body was not cancelled.') => {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 2000);
  })]); } finally { clearTimeout(timer); }
};

async function fixture() {
  const requests = [], expired = new Set(), missing = new Set();
  const bodyHolds = new Set();
  let hold, release, nextBody, nextMaster;
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ path: url.pathname, client: req.headers['x-plex-client-identifier'] });
    if (url.pathname.startsWith('/twirp/')) { res.setHeader('Content-Type', 'application/json'); res.end('{}'); return; }
    if (url.pathname.endsWith('/stop')) { res.end(); return; }
    if (hold && url.pathname.endsWith('/index.m3u8')) {
      const ready = hold; hold = undefined; ready();
      await new Promise(resolve => { release = resolve; });
    }
    const session = url.searchParams.get('session') || url.pathname.split('/')[2];
    if (expired.has(session) || missing.has(url.pathname)) { res.writeHead(404); res.end(); return; }
    if (req.headers.range) { res.writeHead(416); res.end(); return; }
    if (url.pathname.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const playlist = url.pathname.endsWith('/start.m3u8') ?
        `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n/media/${session}/index.m3u8\n` :
        `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/media/${session}/0.ts\n#EXT-X-ENDLIST\n`;
      if (nextMaster && url.pathname.endsWith('/start.m3u8')) {
        const held = nextMaster; nextMaster = undefined;
        res.write(playlist.slice(0, 8)); held.entered.resolve();
        await held.release.promise;
        if (!res.destroyed) res.end(playlist.slice(8));
      } else res.end(playlist);
    } else if (nextBody && url.pathname.endsWith('.ts')) {
      const held = nextBody; nextBody = undefined;
      res.on('close', () => held.closed.resolve());
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': '8192' });
      res.write(Buffer.alloc(4096, 7));
      await held.release.promise;
      if (!res.destroyed) res.end(Buffer.alloc(4096, 8));
    } else { res.setHeader('Content-Type', 'video/mp2t'); res.end(Buffer.alloc(4096, 7)); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const plex = new Plex({ url: `http://127.0.0.1:${upstream.address().port}`, token: 'test-only' });
  plex.metadata = async () => ({ ratingKey: '1', type: 'movie', duration: 600000,
    Media: [{ videoCodec: 'h264', Part: [{ key: '/fixture.mp4', Stream: [{ id: '11', streamType: 3, codec: 'srt' }] }] }] });
  plex.canAccess = async () => true;
  plex.json = async route => route === '/transcode/sessions' ? { TranscodeSession: [...plex.producers.values()]
    .filter(producer => !expired.has(producer.session)).map(producer => ({ id: producer.session })) } :
    { Metadata: [{ Media: [{ Part: [{ Stream: [{ streamType: 1, decision: 'copy' }] }] }] }] };
  const app = createApp({ plex, recordProgress: false, livekitKey: 'fixture-key', livekitSecret: 'test-only'.repeat(4), livekitInternalUrl: plex.url.href });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, cookie, body = {}) => fetch(`${origin}/api/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' }, body: JSON.stringify(body),
  });
  const join = async host => {
    const response = await post('join', '', { name: host ? 'Host' : 'Viewer', host });
    assert.equal(response.status, 200);
    const { identity } = await response.json();
    return { identity, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const host = await join(true), guest = await join(false);
  app.party.select({ id: '1', duration: 600 });
  const playback = async (member, options = {}) => {
    const response = await post('playback', member.cookie, options);
    assert.equal(response.status, 200);
    return response.json();
  };
  const get = (member, resource, headers = {}) => fetch(origin + resource, { headers: { Cookie: member.cookie, ...headers } });
  const childPlaylist = async (member, resource) => {
    const response = await get(member, resource);
    assert.equal(response.status, 200);
    return (await response.text()).split('\n').find(line => line.startsWith('/api/stream/'));
  };
  const mediaSegment = async (member, resource) => childPlaylist(member, await childPlaylist(member, resource));
  return { ...app, plex, host, guest, requests, expired, missing, post, playback, get, childPlaylist, mediaSegment,
    delayPlaylist: () => new Promise(resolve => { hold = resolve; }),
    releasePlaylist: () => release?.(),
    holdSegment: () => {
      const held = { closed: deferred(), release: deferred() };
      bodyHolds.add(held); nextBody = held; return held;
    },
    holdMaster: () => {
      const held = { entered: deferred(), release: deferred() };
      bodyHolds.add(held); nextMaster = held; return held;
    },
    async cleanup() {
      release?.(); for (const held of bodyHolds) held.release.resolve();
      await app.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    },
  };
}

test('shared resources require a current assignment and use the producer identity upstream', async () => {
  const f = await fixture();
  try {
    const [host, guest] = await Promise.all([f.playback(f.host), f.playback(f.guest)]);
    assert.equal(host.outputId, guest.outputId);
    assert.equal(host.url, guest.url);
    const assignment = f.plex.streams.get(f.host.identity);
    const segment = await f.mediaSegment(f.host, host.url);
    assert.equal((await f.get(f.guest, guest.url)).status, 200);
    assert.equal((await f.get(f.host, host.url)).status, 200);
    assert.equal(f.requests.filter(row => row.path.endsWith('/start.m3u8')).length, 1,
      'Reading the canonical manifest from either viewer cannot restart the shared Plex output.');
    assert.equal((await f.get(f.guest, segment)).status, 200);
    assert.equal(f.requests.filter(row => !row.path.endsWith('/stop')).every(row => row.client === assignment.client), true);
    assert.notEqual(assignment.client, `playparty-${f.host.identity}`);
    await f.playback(f.guest, { subtitleId: '11' });
    assert.equal((await f.get(f.guest, segment)).status, 404, 'A different output assignment cannot read another output.');
    assert.equal((await f.get(f.host, segment)).status, 200, 'The original viewer retains its output.');
    await f.post('stop', f.host.cookie);
    assert.equal((await f.get(f.host, segment)).status, 404);
    assert.equal(f.plex.producers.size, 0);
    assert.equal(f.plex.resources.size, 0);
  } finally { await f.cleanup(); }
});

test('a playlist finishing after Stop cannot recreate retired resource mappings', async () => {
  const f = await fixture();
  try {
    const playback = await f.playback(f.host);
    const child = await f.childPlaylist(f.host, playback.url);
    const waiting = f.delayPlaylist();
    const response = f.get(f.host, child);
    await waiting;
    assert.equal((await f.post('stop', f.host.cookie)).status, 200);
    f.releasePlaylist();
    assert.equal((await response).status, 499, 'Retiring an assignment cancels its outstanding upstream playlist request.');
    assert.equal(f.plex.resources.size, 0);
    assert.equal(f.plex.producers.size, 0);
  } finally { await f.cleanup(); }
});

test('invalid ranges and a cancelled reader leave the shared output usable', async () => {
  const f = await fixture();
  try {
    const playback = await f.playback(f.host); await f.playback(f.guest);
    const child = await f.childPlaylist(f.host, playback.url);
    const original = f.plex.streams.get(f.host.identity).id;
    assert.equal((await f.get(f.host, child, { Range: 'bytes=999999-' })).status, 502);
    assert.equal(f.plex.producers.size, 1);
    const waiting = f.delayPlaylist();
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${f.server.address().port}${child}`, { headers: { Cookie: f.guest.cookie }, signal: controller.signal });
    const rejected = assert.rejects(response, error => error.name === 'AbortError');
    await waiting; controller.abort(); f.releasePlaylist(); await rejected;
    assert.equal((await f.get(f.host, playback.url)).status, 200);
    assert.equal(f.plex.streams.get(f.host.identity).id, original);
    assert.equal(f.plex.producers.size, 1);
  } finally { await f.cleanup(); }
});

test('a confirmed upstream expiry retires only that output and matching viewers reacquire one replacement', async () => {
  const f = await fixture();
  try {
    const playback = await f.playback(f.host); await f.playback(f.guest);
    const child = await f.childPlaylist(f.host, playback.url);
    const old = f.plex.streams.get(f.host.identity);
    f.expired.add(old.session);
    assert.equal((await f.get(f.host, child)).status, 502);
    assert.equal(f.plex.streams.size, 0);
    assert.equal(f.plex.producers.size, 0);
    assert.equal(f.plex.resources.size, 0);
    const replacement = await Promise.all([f.playback(f.host), f.playback(f.guest)]);
    assert.equal(replacement[0].outputId, replacement[1].outputId);
    assert.notEqual(replacement[0].outputId, playback.outputId);
    assert.equal((await f.get(f.host, replacement[0].url)).status, 200);
    assert.equal(f.plex.producers.size, 1);
  } finally { await f.cleanup(); }
});

test('one missing segment does not retire an otherwise readable shared output', async () => {
  const f = await fixture();
  try {
    const playback = await f.playback(f.host); await f.playback(f.guest);
    const segment = await f.mediaSegment(f.host, playback.url);
    const resource = f.plex.resources.get(segment.split('/').at(-1));
    f.missing.add(new URL(resource.target, f.plex.url).pathname);
    assert.equal((await f.get(f.guest, segment)).status, 502);
    assert.equal(f.plex.producers.size, 1);
    assert.equal(f.plex.streams.size, 2);
    assert.equal((await f.get(f.host, playback.url)).status, 200);
    f.missing.clear();
    assert.equal((await f.get(f.host, segment)).status, 200);
    assert.equal(f.plex.streams.get(f.host.identity).id, playback.outputId);
  } finally { await f.cleanup(); }
});

test('one missing child playlist preserves every reader of a healthy output', async () => {
  const f = await fixture();
  try {
    const [host, guest] = await Promise.all([f.playback(f.host), f.playback(f.guest)]);
    const child = await f.childPlaylist(f.host, host.url);
    const assignment = f.plex.streams.get(f.host.identity);
    const resource = f.plex.resources.get(child.split('/').at(-1));
    f.missing.add(new URL(resource.target, f.plex.url).pathname);
    assert.equal((await f.get(f.guest, child)).status, 502);
    assert.equal(f.plex.producers.size, 1, 'A child playlist failure does not prove that its healthy Plex session expired.');
    assert.equal(f.plex.streams.size, 2);
    assert.equal(f.plex.streams.get(f.host.identity), assignment);
    assert.equal((await f.get(f.host, host.url)).status, 200);
    f.missing.clear();
    assert.equal((await f.get(f.host, child)).status, 200);
    assert.equal((await f.get(f.guest, child)).status, 200);
    assert.equal((await f.playback(f.guest)).outputId, guest.outputId);
  } finally { await f.cleanup(); }
});

test('leaving or changing profile cancels only that viewer’s outstanding segment body', async t => {
  for (const action of ['leave', 'profile']) await t.test(action, { timeout: 10000 }, async () => {
    const f = await fixture();
    try {
      const [host, guest] = await Promise.all([f.playback(f.host), f.playback(f.guest)]);
      const original = f.plex.streams.get(f.host.identity);
      const segment = await f.mediaSegment(f.host, host.url);
      const held = f.holdSegment();
      const response = await f.get(f.guest, segment);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.value.byteLength, 4096);
      const interrupted = bodyAborted(reader);
      if (action === 'leave') assert.equal((await f.post('leave', f.guest.cookie)).status, 200);
      else assert.notEqual((await f.playback(f.guest, { subtitleId: '11' })).outputId, guest.outputId);
      assert.equal(await within(interrupted), true, 'The old response cannot deliver its held tail after the viewer leaves that assignment.');
      await within(held.closed.promise);
      assert.equal(f.plex.streams.get(f.host.identity), original, 'Another viewer keeps its original assignment.');
      assert.equal(original.producer.retired, false);
      assert.equal((await f.get(f.host, segment)).status, 200, 'Cancelling one reader cannot cancel the host’s requests.');
      assert.equal(f.plex.producers.size, action === 'leave' ? 1 : 2);
    } finally { await f.cleanup(); }
  });
});

test('Stop and seek abort outstanding segment bodies from the retired generation', async t => {
  for (const action of ['stop', 'seek']) await t.test(action, { timeout: 10000 }, async () => {
    const f = await fixture();
    try {
      const [host] = await Promise.all([f.playback(f.host), f.playback(f.guest)]);
      const segment = await f.mediaSegment(f.host, host.url);
      const original = f.plex.streams.get(f.host.identity);
      const held = f.holdSegment();
      const response = await f.get(f.guest, segment);
      const reader = response.body.getReader();
      assert.equal((await reader.read()).value.byteLength, 4096);
      const interrupted = bodyAborted(reader);
      const control = action === 'stop' ? await f.post('stop', f.host.cookie) :
        await f.post('control', f.host.cookie, { action: 'seek', position: 120 });
      assert.equal(control.status, 200);
      assert.equal(await within(interrupted), true, 'The retired generation cannot deliver its held tail.');
      await within(held.closed.promise);
      assert.equal(original.producer.retired, true);
      assert.equal(f.plex.producers.size, 0);
      assert.equal(f.plex.streams.size, 0);
      assert.equal(f.plex.resources.size, 0);
      assert.equal((await f.get(f.host, segment)).status, 404);
      if (action === 'stop') f.party.select({ id: '1', duration: 600 });
      const replacements = await Promise.all([f.playback(f.host), f.playback(f.guest)]);
      assert.equal(replacements[0].outputId, replacements[1].outputId);
      assert.notEqual(replacements[0].outputId, host.outputId);
      assert.equal((await f.get(f.host, await f.mediaSegment(f.host, replacements[0].url))).status, 200);
    } finally { await f.cleanup(); }
  });
});

test('shutdown waits for a detached canonical startup and its final Plex stop', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const master = f.holdMaster();
    const playback = f.post('playback', f.host.cookie);
    await within(master.entered.promise, 'Plex did not receive the canonical startup.');
    const stopping = f.post('stop', f.host.cookie).catch(() => undefined);
    const obsolete = await within(playback, 'Stop did not cancel the obsolete playback request.');
    assert.equal(obsolete.status, 409);
    assert.equal(f.plex.producers.size, 0, 'Stop detaches producer ownership before the held upstream startup finishes.');
    assert.equal(f.plex.streams.size, 0);
    assert.equal(f.requests.filter(row => row.path.endsWith('/stop')).length, 0);
    const transportClosed = once(f.server, 'close');
    let finished = false;
    const closing = f.close().then(() => { finished = true; });
    await within(transportClosed, 'The local HTTP server did not close.');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'Shutdown must retain detached retirement work after closing client connections.');
    master.release.resolve();
    await within(closing, 'Shutdown did not drain the completed startup and final Plex stop.');
    await stopping;
    assert.equal(f.requests.filter(row => row.path.endsWith('/start.m3u8')).length, 1);
    assert.equal(f.requests.filter(row => row.path.endsWith('/stop')).length, 1);
    assert.equal(f.plex.resources.size, 0, 'A late startup cannot restore resources after shutdown.');
  } finally { await f.cleanup(); }
});

test('Stop, selection and seek cancel a pending old startup before admitting new playback', async t => {
  for (const action of ['stop', 'select', 'seek']) await t.test(action, async () => {
    const f = await fixture();
    const metadata = f.plex.metadata;
    let began, unblock, held = true;
    const entered = new Promise(resolve => { began = resolve; });
    f.plex.metadata = async (id, { signal } = {}) => {
      if (held) {
        held = false; began();
        await new Promise((resolve, reject) => {
          unblock = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return metadata(id);
    };
    try {
      const stale = f.post('playback', f.host.cookie);
      await entered;
      const response = action === 'seek' ? await f.post('control', f.host.cookie, { action: 'seek', position: 120 }) :
        await f.post(action, f.host.cookie, action === 'select' ? { id: '1' } : {});
      assert.equal(response.status, 200);
      assert.equal(f.plex.pendingStarts.size, 0, 'Control cancels pending starts, including the metadata phase.');
      assert.equal((await stale).status, 409);
      if (action === 'stop') f.party.select({ id: '1', duration: 600 });
      const next = await f.playback(f.host);
      assert.ok(next.outputId);
      assert.equal(f.plex.producers.size, 1);
      assert.equal(f.plex.streams.size, 1);
    } finally { unblock?.(); await f.cleanup(); }
  });
});

test('only an actual media generation change retires outputs, including replay after the end', async () => {
  const f = await fixture();
  try {
    const playback = await f.playback(f.host); await f.playback(f.guest);
    const version = f.party.mediaVersion;
    const invalid = await f.post('control', f.host.cookie, { action: 'seek', position: 'invalid' });
    assert.equal(invalid.status, 200);
    assert.equal(f.party.mediaVersion, version);
    assert.equal(f.plex.streams.size, 2);
    assert.equal((await f.get(f.host, playback.url)).status, 200);
    f.party.position = f.party.movie.duration;
    f.party.paused = true;
    const replay = await f.post('control', f.host.cookie, { action: 'play' });
    assert.equal(replay.status, 200);
    assert.equal(f.party.mediaVersion, version + 1);
    assert.equal(f.plex.streams.size, 0);
    assert.equal(f.plex.producers.size, 0);
    assert.equal((await f.get(f.guest, playback.url)).status, 404);
    assert.notEqual((await f.playback(f.host)).outputId, playback.outputId);
  } finally { await f.cleanup(); }
});

test('a missing fragment retires its output only when Plex confirms the session is gone', async () => {
  const f = await fixture();
  try {
    const playback = await f.playback(f.host); await f.playback(f.guest);
    const segment = await f.mediaSegment(f.host, playback.url);
    f.expired.add(f.plex.streams.get(f.host.identity).session);
    assert.equal((await f.get(f.guest, segment, { Range: 'bytes=999999-' })).status, 502);
    assert.equal(f.plex.producers.size, 1, 'A Range failure never invalidates other viewers.');
    const metrics = f.plex.transcodeMetrics.bind(f.plex);
    f.plex.transcodeMetrics = async () => { throw Error('Fixture session probe unavailable'); };
    assert.equal((await f.get(f.guest, segment)).status, 502);
    assert.equal(f.plex.producers.size, 1, 'An unavailable session probe cannot establish output loss.');
    f.plex.transcodeMetrics = metrics;
    assert.equal((await f.get(f.guest, segment)).status, 502);
    assert.equal(f.plex.streams.size, 0);
    assert.equal(f.plex.producers.size, 0);
    const replacement = await Promise.all([f.playback(f.host), f.playback(f.guest)]);
    assert.equal(replacement[0].outputId, replacement[1].outputId);
    assert.notEqual(replacement[0].outputId, playback.outputId);
  } finally { await f.cleanup(); }
});
