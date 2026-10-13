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
  assert.equal(capture.start(), first, 'Repeated startup must share one browser request.');
  assert.deepEqual(requests, [{ audio: true, video: true }]);
  capture.dispose();
  consent.resolve(tracks);
  assert.equal(await first, false);
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
  assert.equal(await started, false);
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
  assert.equal(await capture.start(), true);
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
  assert.equal(await capture.start(), true);
  assert.deepEqual(samples.map(sample => sample.event), ['capture-request', 'capture-ready']);
  capture.dispose();
});
