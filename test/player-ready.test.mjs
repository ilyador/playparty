import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Party } from '../server/party.mjs';
import { syncWatchdog } from '../src/sync-watchdog.ts';
import { seekWatchdog } from '../src/seek-watchdog.ts';

const playerCode = ts.transpileModule(fs.readFileSync(new URL('../src/Player.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Run the real Player effects against a deterministic native media fixture.
// These tests cover readiness bookkeeping, not Safari's decoder or autoplay.
function mountPlayer(party, member, { currentTime = party.position, bufferedEnd = 16, bufferedRanges = [[0, bufferedEnd]], engine = 'native' } = {}) {
  const slots = [], pendingEffects = [], intervals = new Set(), requests = [], ready = [], buffering = [], posts = [];
  const listeners = new Map();
  const samples = [], hlsInstances = [], sourceRequests = [];
  let cursor = 0;
  let tree;
  let stateFresh = true;
  let hidden = false;
  const video = {
    paused: true, readyState: 4, currentTime, seeking: false, playbackRate: 1, ended: false, playCalls: 0,
    volume: 1, muted: false, error: null,
    buffered: { length: bufferedRanges.length, start: index => bufferedRanges[index][0], end: index => bufferedRanges[index][1] },
    textTracks: Object.assign([], { addEventListener() {}, removeEventListener() {} }),
    addEventListener(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
    },
    removeEventListener(event, callback) { listeners.get(event)?.delete(callback); },
    remove() {}, removeAttribute() {}, load() { this.ended = false; this.error = null; },
    pause() { this.paused = true; },
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
    canPlayType: () => 'probably',
  };
  const effect = (callback, dependencies) => {
    const index = cursor++;
    const previous = slots[index];
    if (previous && dependencies && dependencies.length === previous.dependencies?.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
    pendingEffects.push(() => {
      previous?.cleanup?.();
      slots[index] = { dependencies, cleanup: callback() };
    });
  };
  const hooks = {
    useRef: current => slots[cursor++] ??= { current },
    useState: initial => {
      const index = cursor++;
      const slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
    },
    useEffect: effect, useLayoutEffect: effect,
  };
  class Hls {
    static isSupported() { return engine === 'hls'; }
    static Events = { ERROR: 'error', BUFFER_APPENDED: 'buffer-appended', FRAG_LOADED: 'frag-loaded' };
    static ErrorTypes = { MEDIA_ERROR: 'media-error', NETWORK_ERROR: 'network-error' };
    handlers = new Map();
    recoveries = 0;
    stops = 0;
    constructor(config) { this.config = config; hlsInstances.push(this); }
    on(event, callback) { this.handlers.set(event, callback); }
    emit(event, data) { this.handlers.get(event)?.(event, data); }
    loadSource() {}
    attachMedia() {}
    recoverMediaError() { this.recoveries++; }
    stopLoad() { this.stops++; }
    destroy() { this.handlers.clear(); }
  }
  const modules = {
    react: hooks,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    './types': {
      api: async (_route, options) => {
        sourceRequests.push(JSON.parse(options.body));
        const result = await new Promise((resolve, reject) => requests.push({ resolve, reject }));
        return result;
      },
      post: (route, body) => { posts.push({ route, body }); return new Promise(() => {}); },
      positionAt: (state, now) => state.position + (state.paused ? 0 : Math.max(0, now - state.updatedAt) / 1000),
      contentTitle: movie => movie.title,
    },
    './movie-audio': { movieAudio: () => ({ dispose() {}, setMuted() {}, setSpeech() {} }) },
    './movie-element': { createMovieElement: element => element },
    './sync-rate': { syncRate: () => 1 },
    './seek-watchdog': { seekWatchdog },
    './sync-watchdog': { syncWatchdog },
    './adaptive-quality': { createAdaptiveQuality: () => ({ configure() {}, sample() {} }) },
    'hls.js': { default: Hls },
  };
  const exports = {};
  vm.runInNewContext(playerCode, {
    exports, require: name => modules[name] || {},
    document: { get hidden() { return hidden; }, addEventListener() {}, removeEventListener() {} },
    window: {
      setInterval: callback => { intervals.add(callback); return callback; },
      clearInterval: callback => intervals.delete(callback), addEventListener() {}, removeEventListener() {},
    },
    AbortController, performance: { now: () => party.clock() + 10000 }, Date: class extends Date { static now() { return party.clock(); } }, setTimeout, clearTimeout,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  });
  const render = () => {
    cursor = 0;
    tree = exports.default({
      mediaElement: video, state: party.snapshot(), stateFresh, owner: member.owner, speaking: false,
      clockOffset: 0, connectionVersion: 1, fullscreen: false, onFullscreen() {}, onStop: async () => {},
      onReady: version => { ready.push(version); party.markReady(member.id, version); },
      onBuffering: version => { buffering.push(version); party.buffering(member.id, version); }, onTelemetry: sample => samples.push(sample),
    });
    pendingEffects.splice(0).forEach(run => run());
  };
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return;
    if (predicate(node.props)) return node.props;
    for (const child of [node.props?.children].flat()) {
      const result = find(child, predicate);
      if (result) return result;
    }
  };
  render();
  return {
    video, ready, buffering, posts, samples, hlsInstances, sourceRequests, render,
    setFresh: value => { stateFresh = value; render(); },
    setHidden: value => { hidden = value; },
    pendingSources: () => requests.length,
    emit: event => [...(listeners.get(event) || [])].forEach(callback => callback({ type: event })),
    tick: () => [...intervals].forEach(callback => callback()),
    control: label => find(tree, props => props?.['aria-label'] === label),
    retry: () => find(tree, props => props?.children === 'Retry movie'),
    alert: () => find(tree, props => props?.role === 'alert'),
    async failSource(error) {
      assert.ok(requests.length, 'A source request must be pending.');
      requests.shift().reject(error);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    async loadSource() {
      assert.ok(requests.length, 'A source request must be pending.');
      requests.shift().resolve({ url: '/fixture', offset: 0, mediaVersion: party.mediaVersion, quality: 'Original video', remote: false, maxBitrate: 0, currentBitrate: 0, subtitleMode: 'none' });
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    dispose: () => slots.forEach(slot => slot?.cleanup?.()),
  };
}

function setup(clock = () => 1000) {
  const party = new Party({ clock });
  const host = party.join('Host', true), guest = party.join('Guest', false);
  host.connected = guest.connected = true;
  party.select({ id: '1', title: 'Fixture', duration: 120, subtitles: [{ id: '9', label: 'English' }] });
  return { party, host, guest };
}

test('a replacement Hls source starts at the current room clock', async () => {
  let now = 1000;
  const { party, host, guest } = setup(() => now);
  party.select({ ...party.movie, duration: 1200, resumePosition: 600 });
  const player = mountPlayer(party, host, { engine: 'hls', currentTime: 600, bufferedRanges: [[600, 620]] });
  try {
    await player.loadSource(); player.tick();
    assert.equal(player.hlsInstances[0].config.startPosition, 600);
    party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt + 139000;
    player.control('Subtitles').onChange({ target: { value: '9' } }); player.render();
    await player.loadSource();
    assert.equal(player.hlsInstances[1].config.startPosition, 739, 'An existing producer’s original 600-second playlist start cannot determine a returning viewer’s first fragment.');
  } finally { player.dispose(); }
});

test('a paused Hls source establishes its first frame before clock alignment', async () => {
  const { party, host } = setup();
  party.select({ ...party.movie, duration: 1200, resumePosition: 12.348 });
  party.control('pause');
  const player = mountPlayer(party, host, { engine: 'hls', currentTime: 0, bufferedRanges: [[12.1415, 43.2313]] });
  try {
    player.video.readyState = 1;
    await player.loadSource(); player.tick();
    assert.equal(player.video.currentTime, 0, 'Room alignment must not interrupt Hls while its initial seek has only metadata.');
    assert.equal(player.hlsInstances[0].config.startOnSegmentBoundary, true);
    player.video.currentTime = 12.1415;
    player.video.readyState = 2; player.tick();
    assert.equal(player.video.paused, true);
    assert.equal(player.ready.length, 0, 'Establishing the initial frame must preserve a manual pause.');
  } finally { player.dispose(); }
});

test('a buffered seek with no decoded frame retries compatible video at the same quality', async () => {
  let now = 1000;
  const { party, host } = setup(() => now);
  party.select({ ...party.movie, duration: 1200, resumePosition: 12.348 });
  const player = mountPlayer(party, host, { engine: 'hls', currentTime: 12.348, bufferedRanges: [[12.1415, 43.2313]] });
  try {
    player.video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 0 });
    await player.loadSource();
    player.video.seeking = true;
    player.tick();
    now += 8100; player.tick(); player.render();
    assert.equal(player.pendingSources(), 1);
    assert.deepEqual(player.sourceRequests[1], { ...player.sourceRequests[0], forceTranscode: true });
    assert.equal(player.video.paused, true, 'The room must stay held during source recovery.');
  } finally { player.dispose(); }
});

for (const gap of [0.103333, 1.103333]) test(`readiness treats a ${gap.toFixed(3)}-second mux gap according to playable buffer`, async () => {
  const { party, host, guest } = setup();
  party.select({ id: 'fixture', duration: 1200 }); party.control('seek', 630);
  party.markReady(guest.id, party.mediaVersion);
  const shift = gap - 0.103333;
  const player = mountPlayer(party, host, { engine: 'hls', bufferedRanges: [[629.019, 633.923833], [634.027166 + shift, 634.086 + shift], [634.17 + shift, 636.160166 + shift]] });
  try {
    await player.loadSource(); player.tick();
    assert.equal(party.paused, gap > 0.2, 'Small A/V mux gaps must not trap a decoded stream below the four-second readiness boundary; real missing media must still wait.');
    assert.equal(party.ready.has(host.id), gap <= 0.2);
    assert.equal(player.pendingSources(), 0, 'Readiness needs no additional reload loop.');
  } finally { player.dispose(); }
});

for (const futureData of [true, false]) test(`a seek inside a real media gap ${futureData ? 'recovers with future data' : 'waits when no future data exists'}`, async () => {
  let now = 1000;
  const { party, host } = setup(() => now);
  party.select({ id: 'fixture', duration: 1200 }); party.control('seek', 666.813);
  const bufferedRanges = [[658.582, 666.629166], ...(futureData ? [[668.8, 700.804166]] : [])];
  const player = mountPlayer(party, host, { engine: 'hls', bufferedRanges });
  try {
    await player.loadSource(); player.video.readyState = 1; player.video.seeking = true;
    player.tick(); now += 8100; player.tick(); player.render();
    assert.equal(player.pendingSources(), futureData ? 1 : 0, 'An unfinished seek can recover when later segments exist; an empty network buffer must keep waiting.');
    assert.equal(party.position, 666.813, 'Recovery cannot jump the shared clock over missing media.');
    assert.ok(party.paused && party.wantsPlay);
    assert.equal(player.samples.filter(sample => sample.event === 'seek-recovery').length, futureData ? 1 : 0);
  } finally { player.dispose(); }
});

for (const status of [503, 200]) test(`temporary playback API ${status} failures retry at most once per thirty seconds and resume readiness`, async () => {
  let now = 1000;
  const { party, host, guest } = setup(() => now);
  const player = mountPlayer(party, host);
  try {
    await player.failSource(Object.assign(new Error('Temporarily unavailable'), { status }));
    player.render();
    assert.ok(player.alert()); assert.equal(player.video.paused, true);
    player.tick(); player.render();
    assert.equal(player.pendingSources(), 1);
    await player.failSource(Object.assign(new Error('Still unavailable'), { status }));
    for (let i = 0; i < 5; i++) { now += 5000; player.tick(); player.render(); }
    assert.equal(player.pendingSources(), 0, 'A persistent outage cannot create a source reload loop.');
    now += 5000; player.tick(); player.render();
    assert.equal(player.pendingSources(), 1);
    await player.loadSource(); player.tick(); player.render();
    assert.equal(player.alert(), undefined);
    party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt; player.tick();
    assert.equal(player.video.paused, false);
    assert.equal(player.samples.filter(sample => sample.event === 'network-recovery').length, 2);
  } finally { player.dispose(); }
});

test('network recovery waits for a fresh room clock and a visible page', async () => {
  const { party, host } = setup();
  const player = mountPlayer(party, host);
  try {
    await player.failSource(new TypeError('Failed to fetch'));
    player.setFresh(false); player.tick(); player.render();
    assert.equal(player.pendingSources(), 0);
    assert.equal(player.retry().disabled, true);
    player.setHidden(true); player.setFresh(true); player.tick(); player.render();
    assert.equal(player.pendingSources(), 0, 'A hidden failed source must not repeatedly start transcodes.');
    player.setHidden(false); player.tick(); player.render();
    assert.equal(player.pendingSources(), 1);
  } finally { player.dispose(); }
});

test('a non-transient API error stays held until movie retry without recreating the player', async () => {
  let now = 1000;
  const { party, host } = setup(() => now);
  const player = mountPlayer(party, host);
  try {
    await player.failSource(Object.assign(new Error('Not found'), { status: 404 }));
    for (let i = 0; i < 10; i++) { now += 10000; player.tick(); player.render(); }
    assert.equal(player.pendingSources(), 0);
    assert.equal(player.video.paused, true);
    assert.ok(player.retry());
    const element = player.video;
    player.retry().onClick(); player.render();
    assert.equal(player.pendingSources(), 1);
    assert.equal(player.video, element);
    await player.loadSource(); player.tick(); player.render();
    assert.equal(player.alert(), undefined);
    assert.ok(party.ready.has(host.id));
  } finally { player.dispose(); }
});

for (const engine of ['native', 'hls']) test(`${engine} network failure revokes readiness and recovers only its movie source`, async () => {
  let now = 1000;
  const { party, host, guest } = setup(() => now);
  const player = mountPlayer(party, host, { engine });
  try {
    await player.loadSource(); player.tick(); party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt; player.tick(); player.emit('playing');
    assert.equal(party.paused, false);
    if (engine === 'native') { player.video.error = { code: 2 }; player.emit('error'); }
    else player.hlsInstances[0].emit('error', { fatal: true, type: 'network-error' });
    assert.equal(party.paused, true, 'A fatal stream error must freeze the shared clock immediately.');
    assert.equal(party.ready.has(host.id), false);
    player.render(); player.tick(); player.render();
    assert.equal(player.pendingSources(), 1);
    assert.equal(player.video.paused, true);
    await player.loadSource(); player.tick();
    assert.ok(party.ready.has(host.id));
    assert.equal(player.samples.filter(sample => sample.event === 'network-recovery').length, 1);
  } finally { player.dispose(); }
});

test('a fatal failure while manually paused revokes readiness without auto-resuming the room', async () => {
  let now = 1000;
  const { party, host, guest } = setup(() => now);
  const player = mountPlayer(party, host, { engine: 'hls' });
  try {
    await player.loadSource(); player.tick(); party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt; player.tick(); player.emit('playing');
    party.control('pause'); player.render(); player.tick();
    player.hlsInstances[0].emit('error', { fatal: true, type: 'network-error' });
    assert.equal(party.ready.has(host.id), false);
    assert.ok(party.paused && !party.wantsPlay, 'A failure cannot undo an intentional pause.');
    player.tick(); player.render();
    await player.loadSource(); player.tick();
    assert.ok(party.paused && !party.wantsPlay, 'A successful retry also preserves manual pause.');
    party.control('play');
    assert.ok(party.paused && party.wantsPlay, 'Play must request readiness for the new source.');
    player.render(); player.tick();
    assert.equal(party.paused, false);
  } finally { player.dispose(); }
});

test('a fatal failure between initial readiness and future start revokes the already-sent ready', async () => {
  const { party, host, guest } = setup();
  const player = mountPlayer(party, host, { engine: 'hls' });
  try {
    await player.loadSource(); player.tick(); party.markReady(guest.id, party.mediaVersion); player.render();
    assert.equal(party.paused, false);
    assert.ok(party.clock() < party.updatedAt, 'The common future start has not arrived yet.');
    for (let i = 0; i < 3; i++) player.hlsInstances[0].emit('error', { fatal: true, type: 'media-error' });
    assert.equal(party.ready.has(host.id), false);
    assert.ok(party.paused && party.wantsPlay, 'A failure after ready must hold the other viewer before future play.');
    player.tick(); player.render();
    assert.equal(player.pendingSources(), 1, 'A decode failure requests independently encoded segments for this viewer.');
    assert.equal(player.sourceRequests.at(-1).forceTranscode, true);
  } finally { player.dispose(); }
});

test('a subtitle source loaded while manually paused cannot inherit old ready state', async () => {
  const { party, host, guest } = setup();
  const player = mountPlayer(party, host);
  try {
    await player.loadSource(); player.tick(); party.markReady(guest.id, party.mediaVersion); player.render();
    player.emit('playing'); party.control('pause'); player.render();
    player.control('Subtitles').onChange({ target: { value: '9' } }); player.render();
    assert.equal(party.ready.has(host.id), false);
    assert.ok(party.paused && !party.wantsPlay);
    party.control('play'); player.render(); player.tick();
    assert.ok(party.paused && party.wantsPlay, 'An unloaded caption stream holds Play.');
    await player.loadSource(); player.tick();
    assert.equal(party.paused, false);
  } finally { player.dispose(); }
});

test('a second buffering cycle gets fresh ready even when resume was shorter than one player poll', async () => {
  const { party, host, guest } = setup();
  party.markReady(guest.id, party.mediaVersion);
  const firstWait = party.snapshot();
  const player = mountPlayer(party, host);
  try {
    await player.loadSource(); player.tick();
    assert.equal(party.paused, false);
    player.render();

    party.buffering(guest.id, party.mediaVersion);
    assert.equal(party.updatedAt, firstWait.updatedAt, 'A fixed clock deliberately makes timestamp-only readiness insufficient.');
    assert.notEqual(party.readinessVersion, firstWait.readinessVersion);
    player.render(); player.tick();
    assert.equal(player.ready.length, 2, 'The player must prove readiness again without a poll of the transient playing state.');
    assert.ok(party.ready.has(host.id));
    assert.equal(party.paused, true);
    party.markReady(guest.id, party.mediaVersion);
    assert.equal(party.paused, false);
  } finally { player.dispose(); }
});

test('a subtitle reload revokes earlier readiness while another viewer is still buffering', async () => {
  const { party, host, guest } = setup();
  const player = mountPlayer(party, host);
  try {
    await player.loadSource(); player.tick();
    assert.ok(party.ready.has(host.id));
    assert.equal(party.paused, true);

    player.control('Subtitles').onChange({ target: { value: '9' } });
    player.video.readyState = 0;
    player.render();
    assert.equal(party.ready.has(host.id), false, 'A replacement source cannot inherit readiness from the old source.');
    party.markReady(guest.id, party.mediaVersion);
    assert.equal(party.paused, true, 'The other viewer becoming ready must not start an unloaded source.');

    await player.loadSource();
    player.video.readyState = 4; player.tick();
    assert.equal(party.paused, false);
    assert.equal(player.ready.length, 2);
  } finally { player.dispose(); }
});

test('seeking to the end retains enough final frames for actual Player readiness', async () => {
  const { party, host, guest } = setup();
  party.markReady(host.id, party.mediaVersion); party.markReady(guest.id, party.mediaVersion);
  party.control('seek', party.movie.duration);
  party.markReady(guest.id, party.mediaVersion);
  const player = mountPlayer(party, host, { bufferedEnd: party.movie.duration });
  try {
    assert.equal(player.control('Movie position').max, 119, 'The range endpoint must target the final playable second.');
    await player.loadSource(); player.tick();
    assert.equal(player.ready.length, 1);
    assert.equal(party.paused, false, 'The shared clock must resume after an end seek.');
    assert.equal(party.position, 119);
  } finally { player.dispose(); }
});

test('natural EOF stays finished until an explicit play requests fresh playback from zero', async () => {
  let now = 1000;
  const { party, host, guest } = setup(() => now);
  const player = mountPlayer(party, host);
  try {
    await player.loadSource(); player.tick();
    party.markReady(guest.id, party.mediaVersion); player.render();
    const version = party.mediaVersion, readiness = party.readinessVersion;
    now = party.updatedAt + party.movie.duration * 1000 - 250;
    player.video.currentTime = party.movie.duration;
    player.video.ended = true;
    player.emit('ended');
    assert.equal(player.posts.length, 1, 'The owner sends the natural-end pause request.');
    player.tick();
    assert.equal(player.video.playCalls, 0, 'A poll cannot replay the ended element before its pause request arrives.');
    assert.equal(party.currentPosition(), 119.75, 'The movie can finish within the permitted sync drift ahead of the shared clock.');
    now += 1000;
    assert.equal(party.currentPosition(), 120, 'An in-flight pause cannot advance progress past the end.');

    now -= 1000;
    party.control(player.posts[0].body.action, player.posts[0].body.position); player.render();
    now += 30000;
    assert.equal(party.position, 120);
    assert.equal(party.currentPosition(), 120);
    player.video.ended = false; player.emit('ended');
    assert.equal(player.posts.length, 1, 'A queued old ended event cannot pause a replacement source.');

    party.control('play');
    assert.equal(party.position, 0);
    assert.equal(party.mediaVersion, version + 1);
    assert.equal(party.readinessVersion, readiness + 1);
    assert.equal(party.ready.size, 0);
    assert.equal(party.paused, true, 'An explicit replay must wait for fresh buffers.');
    player.render();
    player.video.ended = true; player.emit('ended');
    assert.equal(player.posts.length, 1, 'The previous source cannot pause a new replay generation before it loads.');
    player.video.ended = false;
    await player.loadSource();
    player.video.currentTime = 0;
    player.tick();
    assert.equal(party.paused, true, 'The replay still waits for the other viewer.');
    party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt; player.tick();
    assert.equal(player.video.playCalls, 1);
    assert.equal(party.paused, false);
  } finally { player.dispose(); }
});

test('an unsupported native source exposes stream retry and removes its error listener on disposal', async () => {
  const { party, host } = setup();
  const player = mountPlayer(party, host);
  try {
    await player.loadSource();
    player.emit('error'); player.render();
    assert.equal(player.alert(), undefined, 'An old queued error event without a current MediaError is harmless.');
    player.video.error = { code: 4 };
    player.video.readyState = 0;
    player.emit('error'); player.render();
    assert.ok(player.retry(), 'A native media error must expose a movie retry without reloading the call.');
    assert.equal(player.samples.filter(sample => sample.event === 'fatal').length, 1);
  } finally { player.dispose(); }
  const count = player.samples.length;
  player.emit('error');
  assert.equal(player.samples.length, count, 'A disposed source cannot report another fatal error.');
});

test('repeated Hls decoder failures try independent segments at the same quality once, then expose retry', async () => {
  const { party, host } = setup();
  const player = mountPlayer(party, host, { engine: 'hls' });
  try {
    await player.loadSource();
    const hls = player.hlsInstances[0];
    for (let i = 0; i < 3; i++) hls.emit('error', { fatal: true, type: 'media-error' });
    player.render();
    assert.equal(hls.recoveries, 2);
    assert.equal(hls.stops, 1);
    assert.equal(player.pendingSources(), 1);
    assert.deepEqual(player.sourceRequests[1], { ...player.sourceRequests[0], forceTranscode: true }, 'Compatibility changes do not lower the requested quality or alter subtitles.');
    assert.equal(player.samples.filter(sample => sample.event === 'fatal').length, 0);
    await player.loadSource();
    for (let i = 0; i < 3; i++) player.hlsInstances[1].emit('error', { fatal: true, type: 'media-error' });
    player.render();
    assert.equal(player.pendingSources(), 0, 'A failed compatible source must not loop through new encoders.');
    assert.ok(player.alert(), 'A persistent fatal error cannot remain an endless spinner.');
    assert.equal(player.samples.filter(sample => sample.event === 'fatal').length, 1);
    player.video.error = { code: 3 }; player.emit('error');
    assert.equal(player.samples.filter(sample => sample.event === 'fatal').length, 1, 'The native handler must not duplicate Hls errors.');
  } finally { player.dispose(); }
});

test('native decoder recovery changes only compatibility and cannot loop', async () => {
  const { party, host } = setup();
  const player = mountPlayer(party, host);
  try {
    await player.loadSource();
    player.video.error = { code: 3 }; player.emit('error'); player.render();
    assert.equal(player.pendingSources(), 1);
    assert.deepEqual(player.sourceRequests[1], { ...player.sourceRequests[0], forceTranscode: true });
    await player.loadSource();
    player.video.error = { code: 3 }; player.emit('error'); player.render();
    assert.equal(player.pendingSources(), 0);
    assert.ok(player.retry());
  } finally { player.dispose(); }
});

test('a queued playing event from before autoplay refusal cannot release the shared hold', async () => {
  let now = 1000;
  const { party, host, guest } = setup(() => now);
  const player = mountPlayer(party, host);
  try {
    await player.loadSource(); player.tick();
    party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt;
    player.tick();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    player.emit('playing');

    player.video.pause();
    const nativePlay = player.video.play.bind(player.video);
    let refused = false;
    player.video.play = () => {
      if (!refused) { refused = true; return Promise.reject(Object.assign(new Error('Autoplay refused'), { name: 'NotAllowedError' })); }
      return nativePlay();
    };
    now += 350; player.tick();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(party.wantsPlay, true);
    const held = party.currentPosition();

    // The buffering message has reached the server, but its state broadcast
    // has not reached this player when a previous playing event is delivered.
    player.emit('playing');
    player.render();
    assert.ok(player.control('Start playback'), 'A paused element cannot clear its required gesture through a stale playing event.');
    party.markReady(guest.id, party.mediaVersion); player.tick();
    now += 2200;
    assert.equal(party.currentPosition(), held);
    assert.equal(party.paused, true);
    assert.equal(party.ready.has(host.id), false);
    assert.equal(player.video.playCalls, 1, 'The player must not retry successful playback without the required gesture.');
  } finally { player.dispose(); }
});

test('failed hard corrections reload only this source and keep the cooldown through replacement', async () => {
  let now = 1000;
  const { party, host, guest } = setup(() => now);
  const player = mountPlayer(party, host, { bufferedEnd: 120 });
  try {
    await player.loadSource(); player.tick();
    party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt; player.tick();
    player.emit('playing');
    Object.defineProperty(player.video, 'currentTime', { configurable: true, get: () => 0, set() {} });
    for (let i = 0; i < 3; i++) { now += 2100; player.tick(); }
    assert.equal(player.samples.filter(sample => sample.event === 'correction').length, 2);
    assert.equal(player.samples.filter(sample => sample.event === 'sync-recovery').length, 1);
    player.render();
    assert.equal(player.pendingSources(), 1, 'Recovery requests exactly one replacement for the affected player.');

    Object.defineProperty(player.video, 'currentTime', { configurable: true, writable: true, value: party.position });
    await player.loadSource(); player.tick();
    party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt; player.tick(); player.emit('playing');
    const frozen = player.video.currentTime;
    Object.defineProperty(player.video, 'currentTime', { configurable: true, get: () => frozen, set() {} });
    for (let i = 0; i < 4; i++) { now += 2100; player.tick(); player.render(); }
    assert.equal(player.pendingSources(), 0, 'Source replacement cannot reset the 30-second recovery cooldown.');
    assert.equal(player.samples.filter(sample => sample.event === 'sync-recovery').length, 1);
  } finally { player.dispose(); }
});

test('hidden playback resets failed-correction history and normal advancing playback stays healthy', async () => {
  let now = 1000;
  const { party, host, guest } = setup(() => now);
  const player = mountPlayer(party, host, { bufferedEnd: 120 });
  try {
    await player.loadSource(); player.tick();
    party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt; player.tick(); player.emit('playing');
    Object.defineProperty(player.video, 'currentTime', { configurable: true, get: () => 0, set() {} });
    for (let i = 0; i < 2; i++) { now += 2100; player.tick(); }
    player.setHidden(true); now += 10000; player.tick();
    assert.equal(player.samples.filter(sample => sample.event === 'sync-recovery').length, 0);
    player.setHidden(false); now += 2100; player.tick();
    now += 2100; player.tick();
    assert.equal(player.samples.filter(sample => sample.event === 'sync-recovery').length, 0, 'A hidden-period correction cannot become an additional failed active correction.');

    Object.defineProperty(player.video, 'currentTime', { configurable: true, writable: true, value: party.currentPosition() });
    for (let i = 0; i < 4; i++) { now += 2100; player.video.currentTime = party.currentPosition(); player.tick(); }
    assert.equal(player.samples.filter(sample => sample.event === 'sync-recovery').length, 0);
    assert.equal(player.pendingSources(), 0);
  } finally { player.dispose(); }
});

test('stale state blocks ready, corrections and automatic playback until a fresh snapshot arrives', async () => {
  const { party, host } = setup();
  const player = mountPlayer(party, host);
  try {
    await player.loadSource();
    player.setFresh(false);
    player.video.currentTime = 8;
    player.video.paused = false;
    player.emit('playing'); player.emit('canplay'); player.tick();
    assert.equal(player.video.paused, true);
    assert.equal(player.video.currentTime, 8, 'Stale state cannot apply even a buffered correction.');
    assert.equal(player.ready.length, 0);
    assert.equal(player.video.playCalls, 0);

    player.video.currentTime = 0;
    player.setFresh(true);
    assert.equal(player.ready.length, 1, 'Fresh resumption runs the normal readiness check without waiting for another interval.');
  } finally { player.dispose(); }
});

test('freshness loss pauses running playback and late play promises cannot start stale audio', async () => {
  let now = 1000;
  const { party, host, guest } = setup(() => now);
  const player = mountPlayer(party, host);
  try {
    await player.loadSource(); player.tick();
    party.markReady(guest.id, party.mediaVersion); player.render();
    now = party.updatedAt; player.tick();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    player.emit('playing');
    assert.equal(player.video.paused, false);
    player.setFresh(false);
    assert.equal(player.video.paused, true, 'Freshness loss pauses synchronously in the layout effect.');
    player.setFresh(true);
    assert.equal(player.video.paused, false, 'Fresh state resumes synchronization immediately.');
    for (let i = 0; i < 12; i++) await Promise.resolve();

    player.video.pause();
    let resolvePlay;
    player.video.play = () => new Promise(resolve => { resolvePlay = resolve; });
    player.tick(); player.setFresh(false);
    player.video.paused = false; resolvePlay();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(player.video.paused, true, 'A previously requested play checks freshness again when it resolves.');
  } finally { player.dispose(); }
});
