import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Plex } from '../server/plex.mjs';

const movie = { id: '1', version: 7 };
const profile = { remote: true, maxBitrate: 8000 };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function until(check) {
  for (let i = 0; !check() && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'The isolated fixture reached its expected request boundary.');
}

async function fixture(t) {
  const decisions = [], stops = [], holds = new Map();
  let decisionStatus = 200;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const kind = url.pathname.startsWith('/library/metadata/') ? 'metadata' : url.pathname.endsWith('/decision') ? 'decision' : 'stop';
    if (kind === 'decision') decisions.push({ url, client: req.headers['x-plex-client-identifier'] });
    if (kind === 'stop') stops.push({ session: url.searchParams.get('session'), client: req.headers['x-plex-client-identifier'] });
    const hold = holds.get(kind);
    if (hold) { holds.delete(kind); hold.entered.resolve(); await hold.release.promise; }
    const body = kind === 'metadata' ? { MediaContainer: { Metadata: [{ ratingKey: url.pathname.split('/').at(-1), Media: [{ videoCodec: 'hevc', Part: [{ key: '/fixture/media', Stream: [
      { id: '11', streamType: 3, codec: 'srt' }, { id: '12', streamType: 3, codec: 'srt' }, { id: '13', streamType: 3, codec: 'pgs' },
    ] }] }] }] } } : { MediaContainer: { Metadata: [{ Media: [{ Part: [{ Stream: [{ streamType: 1, decision: 'transcode' }] }] }] }] } };
    res.writeHead(kind === 'decision' ? decisionStatus : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const plex = new Plex({ url: `http://127.0.0.1:${server.address().port}`, token: 'fixture-only-token' });
  const allHolds = [];
  t.after(async () => {
    for (const hold of allHolds) hold.release.resolve();
    await Promise.all([...new Set([...plex.streams.keys(), ...plex.pendingStarts.keys()])].map(id => plex.stop(id)));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { plex, decisions, stops,
    failDecision(status) { decisionStatus = status; },
    hold(kind) { const hold = { entered: deferred(), release: deferred() }; holds.set(kind, hold); allHolds.push(hold); return hold; },
  };
}

test('five matching viewers share one Plex decision, stable resources and a frozen start offset', async t => {
  const { plex, decisions, stops } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => plex.start(`viewer-${i}`, movie, { ...profile, position: 20 + i })));
  assert.equal(decisions.length, 1);
  assert.equal(new Set(results.map(result => result.url)).size, 1);
  assert.equal(new Set(results.map(result => result.outputId)).size, 1);
  assert.doesNotThrow(() => JSON.stringify(results), 'Playback responses must not contain internal producer state.');
  const assignments = [...plex.streams.values()];
  assert.equal(new Set(assignments).size, 5, 'Each viewer owns a distinct assignment.');
  assert.equal(new Set(assignments.map(stream => stream.producer)).size, 1);
  assert.equal(new Set(assignments.map(stream => stream.client)).size, 1);
  assert.equal(decisions[0].client, assignments[0].client);
  const firstOffset = decisions[0].url.searchParams.get('offset');
  const later = await plex.start('late-viewer', movie, { ...profile, position: 600 });
  assert.equal(later.url, results[0].url);
  assert.equal(decisions.length, 1, 'Late joining must not restart or seek Plex.');
  const upstream = new URL(plex.resources.get(later.url.split('/').at(-1)).target, plex.url);
  assert.equal(upstream.searchParams.get('offset'), firstOffset);
  assert.equal(upstream.searchParams.get('copyts'), '1');
  const manifest = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?X-Plex-Token=fixture-only-token"\nsegment.mp4\n';
  const rewritten = assignments.map(stream => plex.rewritePlaylist(manifest, upstream, stream));
  assert.equal(new Set(rewritten).size, 1);
  assert.equal(rewritten[0].includes('fixture-only-token'), false);
  assert.equal(stops.length, 0);
});

test('a sole viewer refresh reuses its assignment and only its final departure stops Plex', async t => {
  const { plex, decisions, stops } = await fixture(t);
  const first = await plex.start('viewer', movie, profile);
  const assignment = plex.streams.get('viewer');
  const refreshed = await plex.start('viewer', movie, { ...profile, position: 90 });
  assert.equal(refreshed.url, first.url);
  assert.equal(plex.streams.get('viewer'), assignment);
  assert.equal(decisions.length, 1);
  assert.equal(stops.length, 0);
  await plex.stop('viewer');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].client, assignment.client);
  assert.equal(plex.streams.size, 0);
  assert.equal(plex.producers.size, 0);
  assert.equal(plex.resources.size, 0);
  await plex.stop('viewer', assignment);
  assert.equal(stops.length, 1, 'Repeated stale cleanup stops a producer only once.');
});

test('a quality change and stale cleanup cannot stop another viewer or a newer assignment', async t => {
  const { plex, stops } = await fixture(t);
  await Promise.all(['a', 'b'].map(id => plex.start(id, movie, profile)));
  const previous = plex.streams.get('a');
  const other = plex.streams.get('b');
  const changed = await plex.start('a', movie, { ...profile, maxBitrate: 4000, adaptive: true });
  const current = plex.streams.get('a');
  assert.notEqual(current.id, previous.id);
  assert.equal(plex.streams.get('b'), other);
  assert.equal(stops.length, 0, 'The other viewer still owns the original producer.');
  await plex.stop('a', previous);
  assert.equal(plex.streams.get('a'), current);
  assert.equal(plex.resources.has(changed.url.split('/').at(-1)), true);
  await plex.stop('a');
  assert.equal(stops.length, 1);
  assert.equal(plex.streams.get('b'), other);
  await plex.stop('b');
  assert.equal(stops.length, 2);
});

test('sharing respects codecs, subtitle selection, effective resolution, movie generation and local quality', async t => {
  const { plex, decisions } = await fixture(t);
  const options = [profile, { ...profile, hevc: true }, { ...profile, subtitleId: '11' }, { ...profile, subtitleId: '12' },
    { ...profile, subtitleId: '13' }, { ...profile, maxBitrate: 4000 }, { ...profile, maxBitrate: 4000, adaptive: true }];
  const outputs = await Promise.all(options.map((options, i) => plex.start(`remote-${i}`, movie, options)));
  assert.equal(new Set(outputs.map(result => result.outputId)).size, options.length);
  assert.equal(outputs[2].subtitleMode, 'segmented');
  assert.equal(outputs[3].subtitleMode, 'segmented');
  assert.equal(outputs[4].subtitleMode, 'burn');
  const [localLow, localHigh] = await Promise.all([
    plex.start('local-low', movie, { remote: false, maxBitrate: 1500, adaptive: true }),
    plex.start('local-high', movie, { remote: false, maxBitrate: 99999 }),
  ]);
  assert.equal(localLow.outputId, localHigh.outputId, 'Ignored remote caps must not split local original-quality playback.');
  assert.notEqual(localLow.outputId, outputs[0].outputId);
  const localDecision = decisions.find(row => row.url.searchParams.get('location') === 'lan').url.searchParams;
  assert.equal(localDecision.has('maxVideoBitrate'), false);
  assert.equal(localDecision.get('videoResolution'), '3840x2160');
  const newGeneration = await plex.start('new-generation', { ...movie, version: 8 }, profile);
  const newMovie = await plex.start('new-movie', { ...movie, id: '2' }, profile);
  assert.notEqual(newGeneration.outputId, outputs[0].outputId);
  assert.notEqual(newMovie.outputId, outputs[0].outputId);
});

test('departure during metadata cancels startup without creating an output later', async t => {
  const f = await fixture(t);
  const hold = f.hold('metadata');
  const starting = f.plex.start('viewer', movie, profile);
  const rejected = assert.rejects(starting, { status: 409 });
  await hold.entered.promise;
  await f.plex.stop('viewer');
  await rejected;
  hold.release.resolve();
  assert.equal(f.decisions.length, 0);
  assert.equal(f.stops.length, 0);
  assert.equal(f.plex.pendingStarts.size, 0);
  assert.equal(f.plex.producers.size, 0);
  assert.equal(f.plex.resources.size, 0);
});

test('one departing viewer does not cancel another viewer waiting for the shared decision', async t => {
  const f = await fixture(t);
  const hold = f.hold('decision');
  const departing = f.plex.start('departing', movie, profile);
  const rejected = assert.rejects(departing, { status: 409 });
  await hold.entered.promise;
  const staying = f.plex.start('staying', movie, profile);
  await until(() => f.plex.pendingStarts.get('staying')?.assignment);
  await f.plex.stop('departing');
  await rejected;
  assert.equal(f.stops.length, 0);
  hold.release.resolve();
  const result = await staying;
  assert.equal(f.decisions.length, 1);
  assert.equal(f.plex.streams.get('staying').id, result.outputId);
  assert.equal(f.plex.streams.has('departing'), false);
});

test('last departure during a pending shared decision retires it once and cannot revive resources', async t => {
  const f = await fixture(t);
  const hold = f.hold('decision');
  const a = f.plex.start('a', movie, profile);
  const rejectedA = assert.rejects(a, { status: 409 });
  await hold.entered.promise;
  const b = f.plex.start('b', movie, profile);
  const rejectedB = assert.rejects(b, { status: 409 });
  await until(() => f.plex.pendingStarts.get('b')?.assignment);
  const abandoned = f.plex.pendingStarts.get('a').assignment;
  await Promise.all(['a', 'b'].map(id => f.plex.stop(id)));
  await Promise.all([rejectedA, rejectedB]);
  hold.release.resolve();
  assert.equal(f.stops.length, 1);
  assert.equal(f.plex.streams.size, 0);
  assert.equal(f.plex.producers.size, 0);
  assert.equal(f.plex.resources.size, 0);
  const replacement = await f.plex.start('a', movie, profile);
  assert.notEqual(replacement.outputId, abandoned.id);
  await f.plex.stop('a', abandoned);
  assert.equal(f.plex.streams.get('a').id, replacement.outputId);
});

test('a failed shared startup keeps the previous working output and permits a clean retry', async t => {
  const f = await fixture(t);
  await f.plex.start('a', movie, profile);
  const working = f.plex.streams.get('a');
  const hold = f.hold('decision');
  f.failDecision(500);
  const a = f.plex.start('a', movie, { ...profile, maxBitrate: 4000 });
  const rejectedA = assert.rejects(a, { status: 502, upstreamStatus: 500 });
  await hold.entered.promise;
  const b = f.plex.start('b', movie, { ...profile, maxBitrate: 4000 });
  const rejectedB = assert.rejects(b, { status: 502, upstreamStatus: 500 });
  await until(() => f.plex.pendingStarts.get('b')?.assignment);
  const failed = f.plex.pendingStarts.get('b').assignment;
  hold.release.resolve();
  await Promise.all([rejectedA, rejectedB]);
  assert.equal(f.plex.streams.get('a'), working);
  assert.equal(f.plex.streams.has('b'), false);
  assert.equal(f.plex.producers.size, 1);
  assert.equal(f.stops.length, 1);
  f.failDecision(200);
  const retry = await f.plex.start('b', movie, { ...profile, maxBitrate: 4000 });
  assert.notEqual(retry.outputId, failed.id);
  assert.equal(f.plex.streams.get('a'), working);
});

test('confirmed output loss retires all assignments once, without touching a later replacement', async t => {
  const { plex, stops } = await fixture(t);
  await Promise.all(['a', 'b'].map(id => plex.start(id, movie, profile)));
  const oldA = plex.streams.get('a'), oldB = plex.streams.get('b');
  const base = new URL('/fixture/index.m3u8', plex.url);
  plex.rewritePlaylist('#EXTM3U\nsegment.mp4\n', base, oldA);
  await Promise.all([plex.invalidate(oldA), plex.invalidate(oldB)]);
  assert.equal(stops.length, 1);
  assert.equal(plex.streams.size, 0);
  assert.equal(plex.producers.size, 0);
  assert.equal(plex.resources.size, 0);
  assert.throws(() => plex.addResource(oldA, '/late.mp4'), { status: 410 });
  assert.throws(() => plex.rewritePlaylist('#EXTM3U\nlate.mp4\n', base, oldB), { status: 410 });
  const replacement = await plex.start('a', movie, profile);
  await plex.invalidate(oldA);
  assert.equal(stops.length, 1);
  assert.equal(plex.streams.get('a').id, replacement.outputId);
  assert.equal(plex.resources.has(replacement.url.split('/').at(-1)), true);
});

test('metadata and shared decision deadlines remain bounded when cancellation is supported', async t => {
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = milliseconds => originalTimeout(milliseconds === 20000 ? 100 : milliseconds);
  t.after(() => { AbortSignal.timeout = originalTimeout; });
  const f = await fixture(t);
  for (const kind of ['metadata', 'decision']) {
    const hold = f.hold(kind);
    const started = performance.now();
    await assert.rejects(f.plex.start('viewer', movie, profile), { name: 'TimeoutError' });
    assert.ok(performance.now() - started < 1000, `${kind} must honor the shortened test deadline.`);
    hold.release.resolve();
    assert.equal(f.plex.pendingStarts.size, 0);
    assert.equal(f.plex.producers.size, 0);
    assert.equal(f.plex.resources.size, 0);
  }
});
