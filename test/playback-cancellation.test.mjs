import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, reuse = false) {
  const gate = deferred(), entered = deferred(), observed = new Map(), starts = [], stopped = [];
  const initial = { id: 'existing', version: 1 };
  const plex = {
    canAccess: async () => true, streams: new Map(),
    async start(identity, movie, options) {
      starts.push(options.subtitleId);
      if (starts.length === 1) { entered.resolve(); await gate.promise; }
      const assignment = reuse ? initial : { id: options.subtitleId, version: movie.version };
      plex.streams.set(identity, assignment);
      return { url: `/api/stream/${assignment.id}`, outputId: assignment.id };
    },
    async stop(identity, expected) {
      const current = plex.streams.get(identity);
      if (expected && current !== expected) return;
      stopped.push(current);
      plex.streams.delete(identity);
    },
  };
  const app = createApp({ plex, recordProgress: false, livekitKey: 'fixture-key', livekitSecret: 'test-only'.repeat(4) });
  const watch = label => {
    if (!observed.has(label)) observed.set(label, { arrived: deferred(), closed: deferred() });
    return observed.get(label);
  };
  app.server.prependListener('request', (req, res) => {
    if (req.url !== '/api/playback') return;
    const events = watch(req.headers['x-test-request']);
    req.once('end', () => setImmediate(() => events.arrived.resolve()));
    res.once('close', () => events.closed.resolve());
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const joined = await fetch(origin + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Viewer"}' });
  assert.equal(joined.status, 200);
  const identity = (await joined.json()).identity, cookie = joined.headers.get('set-cookie').split(';')[0];
  app.party.select({ id: '1', duration: 600 });
  if (reuse) plex.streams.set(identity, initial);
  const request = (label, signal, subtitleId = label) => fetch(origin + '/api/playback', {
    method: 'POST', signal, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Test-Request': label },
    body: JSON.stringify({ subtitleId }),
  });
  t.after(async () => { gate.resolve(); await app.close(); });
  return { ...app, plex, gate, entered, watch, request, starts, stopped, identity, initial };
}

test('an abandoned queued playback request never starts Plex before the latest request', { timeout: 5000 }, async t => {
  const f = await fixture(t), abort = new AbortController();
  const first = f.request('a');
  await f.entered.promise;
  const queued = f.watch('b'), abandoned = f.request('b', abort.signal);
  const rejected = assert.rejects(abandoned, error => error.name === 'AbortError');
  await queued.arrived.promise;
  abort.abort(); await rejected; await queued.closed.promise;
  const latest = f.request('c'); await f.watch('c').arrived.promise;
  f.gate.resolve();
  assert.equal((await first).status, 200);
  assert.equal((await latest).status, 200);
  assert.deepEqual(f.starts, ['a', 'c']);
  assert.equal(f.plex.streams.get(f.identity).id, 'c');
});

test('an abandoned in-flight playback releases its new assignment before the next request adopts it', { timeout: 5000 }, async t => {
  const f = await fixture(t), abort = new AbortController();
  const abandoned = f.request('same', abort.signal);
  const rejected = assert.rejects(abandoned, error => error.name === 'AbortError');
  await f.entered.promise;
  abort.abort(); await rejected; await f.watch('same').closed.promise;
  const latest = f.request('latest', undefined, 'same'); await f.watch('latest').arrived.promise;
  f.gate.resolve();
  assert.equal((await latest).status, 200);
  assert.equal(f.stopped.length, 1);
  assert.notEqual(f.stopped[0], f.plex.streams.get(f.identity));
  assert.equal(f.plex.streams.get(f.identity).id, 'same');
});

test('an abandoned duplicate playback preserves its existing playing assignment', { timeout: 5000 }, async t => {
  const f = await fixture(t, true), abort = new AbortController();
  const abandoned = f.request('duplicate', abort.signal);
  const rejected = assert.rejects(abandoned, error => error.name === 'AbortError');
  await f.entered.promise;
  abort.abort(); await rejected; await f.watch('duplicate').closed.promise;
  f.gate.resolve();
  await f.request('current');
  assert.equal(f.plex.streams.get(f.identity), f.initial);
  assert.deepEqual(f.stopped, []);
});
