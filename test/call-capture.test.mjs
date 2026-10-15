import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(fs.readFileSync(new URL('../src/call-capture.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function controller(participant, diagnostics, permissions) {
  const exports = {};
  vm.runInNewContext(code, { exports, navigator: { permissions } });
  return exports.callCapture(participant, diagnostics);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function track(kind) {
  return { kind, readyState: 'live', stop() { this.readyState = 'ended'; } };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('a permission request resolved after leaving releases both devices without publishing', async () => {
  const consent = deferred();
  const tracks = [track('audio'), track('video')];
  const requests = [], publications = [];
  const capture = controller({
    createTracks: options => { requests.push(structuredClone(options)); return consent.promise; },
    publishTrack: async track => { publications.push(track); },
    unpublishTrack: async () => {},
  });
  const first = capture.start();
  assert.deepEqual(requests, [{ audio: true, video: true }]);
  capture.dispose();
  consent.resolve(tracks);
  await first;
  assert.deepEqual(publications, []);
  assert.deepEqual(tracks.map(track => track.readyState), ['ended', 'ended']);
});

test('leaving during publication releases devices immediately and removes late publications', async () => {
  const tracks = [track('audio'), track('video')];
  const gates = new Map(tracks.map(track => [track, deferred()]));
  const pending = new Map(), published = new Set(), unpublished = [];
  const capture = controller({
    createTracks: async () => tracks,
    publishTrack: track => {
      const promise = gates.get(track).promise.then(() => { published.add(track); });
      pending.set(track, promise);
      return promise;
    },
    unpublishTrack: async track => {
      await pending.get(track);
      published.delete(track);
      unpublished.push(track);
    },
  });
  const started = capture.start();
  await flush();
  assert.equal(pending.size, 2);
  capture.dispose();
  assert.deepEqual(tracks.map(track => track.readyState), ['ended', 'ended']);
  for (const gate of gates.values()) gate.resolve();
  await started;
  assert.equal(published.size, 0);
  assert.equal(unpublished.length, 2);
});

test('one failed publication releases both devices and cleans up its still-pending sibling', async () => {
  const tracks = [track('audio'), track('video')];
  const gates = new Map(tracks.map(track => [track, deferred()]));
  const pending = new Map(), published = new Set();
  const capture = controller({
    createTracks: async () => tracks,
    publishTrack: track => {
      const promise = gates.get(track).promise.then(() => { published.add(track); });
      pending.set(track, promise);
      return promise;
    },
    unpublishTrack: async track => { await pending.get(track); published.delete(track); },
  });
  const started = capture.start();
  await flush();
  gates.get(tracks[0]).reject(new Error('publication failed'));
  await assert.rejects(started, /publication failed/);
  assert.deepEqual(tracks.map(track => track.readyState), ['ended', 'ended']);
  gates.get(tracks[1]).resolve();
  await flush();
  assert.equal(published.size, 0);
  capture.dispose();
});

test('unsupported permission queries do not block the combined capture or publication', async () => {
  const samples = [], requests = [];
  const tracks = [track('audio'), track('video')];
  const capture = controller({
    createTracks: async options => { requests.push(structuredClone(options)); return tracks; },
    publishTrack: async () => {},
    unpublishTrack: async () => {},
  }, sample => samples.push(structuredClone(sample)), { query: async () => { throw new TypeError('unsupported permission'); } });
  await capture.start();
  await flush();
  assert.deepEqual(requests, [{ audio: true, video: true }]);
  assert.deepEqual(samples, [
    { event: 'capture-request', audio: true, video: true },
    { event: 'capture-ready', audio: true, video: true },
  ]);
  assert.deepEqual(tracks.map(track => track.readyState), ['live', 'live']);
  capture.dispose();
  assert.deepEqual(tracks.map(track => track.readyState), ['ended', 'ended']);
});

test('capture diagnostics contain only event, device booleans and browser permission states', async () => {
  const samples = [];
  const capture = controller({
    createTracks: async () => { throw new Error('permission denied'); },
    publishTrack: async () => assert.fail('Denied capture cannot publish.'),
    unpublishTrack: async () => {},
  }, sample => samples.push(structuredClone(sample)), {
    query: async ({ name }) => ({ state: name === 'microphone' ? 'denied' : 'granted', deviceId: 'never log this', label: 'never log this' }),
  });
  await assert.rejects(capture.start(), /permission denied/);
  await flush();
  for (const event of ['capture-request', 'capture-error']) {
    const sample = samples.filter(sample => sample.event === event).at(-1);
    assert.equal(sample.microphonePermission, 'denied');
    assert.equal(sample.cameraPermission, 'granted');
    assert.ok(Object.keys(sample).every(key => ['event', 'audio', 'video', 'captureError', 'microphonePermission', 'cameraPermission'].includes(key)));
  }
});

test('pending Safari permission queries cannot hide capture diagnostics', async () => {
  const samples = [];
  const capture = controller({ createTracks: async () => [track('audio'), track('video')], publishTrack: async () => {}, unpublishTrack: async () => {} }, sample => samples.push(structuredClone(sample)), { query: () => new Promise(() => {}) });
  await capture.start();
  assert.deepEqual(samples.map(sample => sample.event), ['capture-request', 'capture-ready']);
  capture.dispose();
});

test('failed camera retry releases its own device and preserves an enabled microphone', async () => {
  const microphone = track('audio'), camera = track('video'), published = new Set();
  let attempts = 0;
  const capture = controller({
    createTracks: async options => {
      if (++attempts === 1) throw new Error('Initial permission denied');
      return options.audio ? [microphone] : [camera];
    },
    publishTrack: async track => { if (track === camera) throw new Error('Camera publication failed'); published.add(track); },
    unpublishTrack: async track => { published.delete(track); },
  });
  await assert.rejects(capture.start(), /Initial permission denied/);
  assert.equal(capture.active, true, 'A denied initial request must permit device retries.');
  await capture.enable('mic');
  await assert.rejects(capture.enable('camera'), /Camera publication failed/);
  await flush();
  assert.equal(microphone.readyState, 'live');
  assert.equal(camera.readyState, 'ended');
  assert.deepEqual([...published], [microphone]);
  capture.dispose(); await flush();
  assert.equal(microphone.readyState, 'ended');
  assert.equal(published.size, 0);
});

test('pending microphone and camera retries stop without publishing after leave', async () => {
  for (const kind of ['mic', 'camera']) {
    const consent = deferred(), device = track(kind === 'mic' ? 'audio' : 'video');
    let requests = 0, publications = 0;
    const capture = controller({
      createTracks: () => { requests++; return consent.promise; },
      publishTrack: async () => { publications++; },
      unpublishTrack: async () => {},
    });
    const pending = capture.enable(kind);
    capture.dispose(); consent.resolve([device]);
    await pending;
    assert.equal(requests, 1);
    assert.equal(publications, 0);
    assert.equal(device.readyState, 'ended');
    assert.equal(capture.active, false);
    await capture.enable(kind);
    assert.equal(requests, 1);
  }
});

test('leaving before SDK publication is registered still removes a publication that finishes late', async () => {
  const beforeRegistration = deferred(), publication = deferred(), device = track('audio');
  let pending, published = false, unpublishes = 0;
  const capture = controller({
    createTracks: async () => [device],
    publishTrack: async () => {
      // LiveKit first awaits reconnect/republish state, then registers its
      // pending publication promise. An earlier unpublish cannot wait for it.
      await beforeRegistration.promise;
      pending = publication.promise;
      await pending; published = true;
    },
    unpublishTrack: async () => { unpublishes++; await pending; published = false; },
  });
  const started = capture.start(); await flush();
  capture.dispose(); await flush();
  beforeRegistration.resolve(); await flush(); publication.resolve();
  await started;
  assert.equal(published, false);
  assert.equal(device.readyState, 'ended');
  assert.equal(unpublishes, 2, 'An early completed unpublish must not suppress post-publication cleanup.');
});
