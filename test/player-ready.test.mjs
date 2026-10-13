import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Party } from '../server/party.mjs';
import { syncWatchdog } from '../src/sync-watchdog.ts';

const playerCode = ts.transpileModule(fs.readFileSync(new URL('../src/Player.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Run the real Player effects against a deterministic native media fixture.
// These tests cover readiness bookkeeping, not Safari's decoder or autoplay.
function mountPlayer(party, member, { currentTime = party.position, bufferedEnd = 16, engine = 'native' } = {}) {
  const slots = [], pendingEffects = [], intervals = new Set(), requests = [], ready = [], buffering = [], posts = [];
  const listeners = new Map();
  const samples = [], hlsInstances = [];
  let cursor = 0;
  let tree;
  let stateFresh = true;
  let hidden = false;
  const video = {
    paused: true, readyState: 4, currentTime, seeking: false, playbackRate: 1, ended: false, playCalls: 0,
    volume: 1, muted: false, error: null,
    buffered: { length: 1, start: () => 0, end: () => bufferedEnd },
    textTracks: Object.assign([], { addEventListener() {}, removeEventListener() {} }),
    addEventListener(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
    },
    removeEventListener(event, callback) { listeners.get(event)?.delete(callback); },
    remove() {}, removeAttribute() {}, load() { this.ended = false; },
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
    static ErrorTypes = { MEDIA_ERROR: 'media-error' };
    handlers = new Map();
    recoveries = 0;
    stops = 0;
    constructor() { hlsInstances.push(this); }
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
      api: async () => {
        const result = await new Promise(resolve => requests.push(resolve));
        return result;
      },
      post: (route, body) => { posts.push({ route, body }); return new Promise(() => {}); },
      positionAt: (state, now) => state.position + (state.paused ? 0 : Math.max(0, now - state.updatedAt) / 1000),
      contentTitle: movie => movie.title,
    },
    './movie-audio': { movieAudio: () => ({ dispose() {}, setMuted() {}, setSpeech() {} }) },
    './movie-element': { createMovieElement: element => element },
    './sync-rate': { syncRate: () => 1 },
    './seek-watchdog': { seekWatchdog: () => ({ reset() {}, sample: () => ({ stalled: false, reload: false }) }) },
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
    video, ready, buffering, posts, samples, hlsInstances, render,
    setFresh: value => { stateFresh = value; render(); },
    setHidden: value => { hidden = value; },
    pendingSources: () => requests.length,
    emit: event => [...(listeners.get(event) || [])].forEach(callback => callback({ type: event })),
    tick: () => [...intervals].forEach(callback => callback()),
    control: label => find(tree, props => props?.['aria-label'] === label),
    alert: () => find(tree, props => props?.role === 'alert'),
    async loadSource() {
      assert.ok(requests.length, 'A source request must be pending.');
      requests.shift()({ url: '/fixture', offset: 0, mediaVersion: party.mediaVersion, quality: 'Original video', remote: false, maxBitrate: 0, currentBitrate: 0, subtitleMode: 'none' });
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

test('a native media failure exposes reconnect and removes its error listener on disposal', async () => {
  const { party, host } = setup();
  const player = mountPlayer(party, host);
  try {
    await player.loadSource();
    player.emit('error'); player.render();
    assert.equal(player.alert(), undefined, 'An old queued error event without a current MediaError is harmless.');
    player.video.error = { code: 3 };
    player.video.readyState = 0;
    player.emit('error'); player.render();
    assert.ok(player.alert(), 'A native media error must expose the existing reconnect UI.');
    assert.equal(player.samples.filter(sample => sample.event === 'fatal').length, 1);
  } finally { player.dispose(); }
  const count = player.samples.length;
  player.emit('error');
  assert.equal(player.samples.length, count, 'A disposed source cannot report another fatal error.');
});

test('repeated fatal Hls media failures stop after two recovery attempts and expose reconnect', async () => {
  const { party, host } = setup();
  const player = mountPlayer(party, host, { engine: 'hls' });
  try {
    await player.loadSource();
    const hls = player.hlsInstances[0];
    for (let i = 0; i < 3; i++) hls.emit('error', { fatal: true, type: 'media-error' });
    player.render();
    assert.equal(hls.recoveries, 2);
    assert.equal(hls.stops, 1);
    assert.ok(player.alert(), 'A persistent fatal error cannot remain an endless spinner.');
    assert.equal(player.samples.filter(sample => sample.event === 'fatal').length, 1);
    player.video.error = { code: 3 }; player.emit('error');
    assert.equal(player.samples.filter(sample => sample.event === 'fatal').length, 1, 'The native handler must not duplicate Hls errors.');
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
