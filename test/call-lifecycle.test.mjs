import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, Track, setLogLevel } from 'livekit-client';

setLogLevel('silent');

// Run App's hooks and event handlers with the installed SDK's participant and
// local tracks. Only browser capture and transport publication are simulated.
class NativeTrack extends EventTarget {
  constructor(kind) { super(); Object.assign(this, { kind, id: `test-${kind}`, readyState: 'live', enabled: true, muted: false }); }
  getConstraints() { return {}; }
  getSettings() { return {}; }
  stop() { this.readyState = 'ended'; }
}
globalThis.MediaStreamTrack = NativeTrack;
globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } };

function tracks(audio = true, video = true) {
  return [audio && new LocalAudioTrack(new NativeTrack('audio'), {}, false), video && new LocalVideoTrack(new NativeTrack('video'), {}, false)].filter(Boolean).map(track => {
    track.source = track.kind === 'audio' ? Track.Source.Microphone : Track.Source.Camera;
    return track;
  });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const source = name => ts.transpileModule(fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function module(name, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(source(name), { exports, require: name => imports[name], ...globals });
  return exports;
}
function app(plans, timers = { setInterval, clearInterval }) {
  const slots = [], effects = [], rooms = [], sockets = [];
  let cursor = 0, tree, identity = 0;
  const media = { permissions: { query: async () => ({ state: 'granted' }) } };
  const capture = module('call-capture.ts', {}, { navigator: media });
  const audio = module('call-audio.ts');
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(setup, dependencies) {
      const index = cursor++;
      if (!slots[index] || dependencies.some((value, i) => value !== slots[index].dependencies[i])) {
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { dependencies, cleanup: setup() }; });
      }
    },
  };
  class CallRoom extends EventEmitter {
    constructor(options) {
      super();
      this.plan = plans[rooms.length];
      this.localParticipant = new Room(options).localParticipant;
      this.localParticipant.identity = `person-${identity}`;
      this.remoteParticipants = new Map(); this.activeSpeakers = []; this.requests = [];
      const participant = this.localParticipant;
      participant.createTracks = options => { this.requests.push(options); return this.plan.capture(options, this.requests.length); };
      participant.publishTrack = async track => {
        const sid = `publication-${participant.trackPublications.size}`;
        track.sid = sid;
        const pub = { track, trackSid: sid, kind: track.kind, source: track.source,
          get isMuted() { return this.track?.isMuted ?? true; },
          get audioTrack() { return this.track?.kind === 'audio' ? this.track : undefined; },
          get videoTrack() { return this.track?.kind === 'video' ? this.track : undefined; },
          mute() { return this.track?.mute(); }, unmute() { return this.track?.unmute(); }, setTrack(track) { this.track = track; },
        };
        participant.trackPublications.set(sid, pub);
        track.on('muted', () => this.emit(RoomEvent.TrackMuted));
        track.on('unmuted', () => this.emit(RoomEvent.TrackUnmuted));
        this.emit(RoomEvent.LocalTrackPublished);
        return pub;
      };
      rooms.push(this);
    }
    connect() { return this.plan.connection || Promise.resolve(); }
    startAudio() { return Promise.resolve(); }
    disconnect() {
      for (const pub of this.localParticipant.trackPublications.values()) void this.localParticipant.unpublishTrack(pub.track);
      this.emit(RoomEvent.Disconnected);
      return Promise.resolve();
    }
  }
  const state = { movie: null, participants: [], hostPresent: false };
  const App = module('App.tsx', {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    'livekit-client': { Room: CallRoom, RoomEvent, Track, AudioPresets: {}, VideoPresets: {} },
    '@phosphor-icons/react': {}, './Call': {}, './Library': {}, './Player': { default: 'player' },
    './call-capture': capture, './call-audio': audio, './movie-element': { createMovieElement: () => ({}) },
    './types': {
      contentTitle: content => content.title,
      api: async () => ({ state, owner: false }),
      post: async path => path === 'join' ? { identity: `person-${++identity}`, name: 'Test', owner: false, state, livekitUrl: '', token: '' } : {},
    },
  }, {
    localStorage: { getItem: () => 'Test', setItem() {} }, location: { search: '', protocol: 'http:', host: 'localhost' },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { body: { appendChild() {} }, fullscreenElement: null },
    WebSocket: class {
      static OPEN = 1;
      readyState = 0; sent = [];
      constructor() { sockets.push(this); }
      send(message) { this.sent.push(JSON.parse(message)); }
      close() { this.readyState = 3; }
    },
    AbortController, URLSearchParams, setTimeout, clearTimeout, ...timers,
  }).default;
  function render() { cursor = 0; tree = App(); while (effects.length) effects.shift()(); return tree; }
  function find(predicate, node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) { const match = find(predicate, child); if (match) return match; } }
    else if (predicate(node)) return node;
    else return find(predicate, node.props?.children);
  }
  render();
  return {
    rooms, sockets, render,
    player: () => find(node => node.type === 'player', tree)?.props,
    button: label => find(node => node.type === 'button' && node.props['aria-label'] === label, tree).props,
    notice: () => find(node => node.props?.className === 'notice', tree)?.props.children[0].props.children,
    async join() { await find(node => node.type === 'form', tree).props.onSubmit({ preventDefault() {} }); render(); await flush(); render(); },
    async leave() { await this.button('Leave the call').onClick(); render(); await flush(); render(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('startup capture blocks a second device request, and SDK mute disables the only microphone', async t => {
  const connection = deferred(), consent = deferred(), initial = tracks();
  const view = app([{ connection: connection.promise, capture: () => consent.promise }]);
  t.after(() => view.dispose());
  await view.join();
  assert.equal(view.button('Turn on microphone').disabled, true);
  await view.button('Turn on microphone').onClick();
  assert.equal(view.rooms[0].requests.length, 0);
  connection.resolve(); await flush(); view.render();
  assert.equal(view.button('Turn on microphone').disabled, true);
  await view.button('Turn on microphone').onClick();
  assert.equal(view.rooms[0].requests.length, 1);
  consent.resolve(initial); await flush(); view.render();
  assert.equal(view.button('Mute microphone').disabled, false);
  await view.button('Mute microphone').onClick(); await flush(); view.render();
  assert.equal(view.rooms[0].requests.length, 1);
  assert.equal([...view.rooms[0].localParticipant.trackPublications.values()].filter(pub => pub.kind === 'audio').length, 1);
  assert.equal(initial[0].mediaStreamTrack.enabled, false);
  assert.equal(view.button('Turn on microphone')['aria-pressed'], false);
  await view.button('Turn on microphone').onClick(); await flush(); view.render();
  assert.equal(initial[0].mediaStreamTrack.enabled, true);
  assert.equal(view.rooms[0].requests.length, 1, 'Ordinary unmute must retain the original capture.');
  await view.button('Mute microphone').onClick();
  assert.equal(initial[0].mediaStreamTrack.enabled, false);
});

test('permission retries are owned across leave/rejoin, and old completion cannot unlock a new toggle', async t => {
  const oldConsent = deferred(), newConsent = deferred(), oldMic = tracks(true, false), newMic = tracks(true, false);
  const denied = () => Promise.reject(Object.assign(new Error('Denied'), { name: 'NotAllowedError' }));
  const view = app([
    { capture: (_options, count) => count === 1 ? denied() : oldConsent.promise },
    { capture: (_options, count) => count === 1 ? denied() : newConsent.promise },
  ]);
  t.after(() => view.dispose());
  await view.join();
  assert.equal(view.button('Turn on microphone').disabled, false, 'Denied initial capture must permit a new user gesture.');
  const oldToggle = view.button('Turn on microphone').onClick();
  await view.leave(); await view.join();
  const expectedNotice = view.notice();
  const newToggle = view.button('Turn on microphone').onClick();
  assert.equal(view.rooms[1].requests.length, 2, 'A pending old session must not block new-session controls.');
  oldConsent.resolve(oldMic); await oldToggle; await flush(); view.render();
  assert.equal(oldMic[0].mediaStreamTrack.readyState, 'ended');
  assert.equal(view.rooms[0].localParticipant.trackPublications.size, 0);
  assert.equal(view.notice(), expectedNotice, 'Old success must not clear the new call notice.');
  await view.button('Turn on camera').onClick();
  assert.equal(view.rooms[1].requests.length, 2, 'Old completion must not release the new toggle lock.');
  newConsent.resolve(newMic); await newToggle; await flush(); view.render();
  assert.equal(view.button('Mute microphone')['aria-pressed'], true);
  await view.button('Mute microphone').onClick();
  assert.equal(newMic[0].mediaStreamTrack.enabled, false);
});

test('a terminal disconnect disposes pending startup and keeps device controls disabled', async t => {
  const consent = deferred(), initial = tracks();
  const view = app([{ capture: () => consent.promise }]);
  t.after(() => view.dispose());
  await view.join();
  view.rooms[0].disconnect();
  consent.resolve(initial); await flush(); view.render();
  assert.equal(view.button('Turn on microphone').disabled, true);
  assert.equal(view.rooms[0].localParticipant.trackPublications.size, 0);
  assert.ok(initial.every(track => track.mediaStreamTrack.readyState === 'ended'));
});

test('native device recovery remains owned when leaving before or after the permission request', async t => {
  for (const kind of ['mic', 'camera']) for (const pending of [false, true]) {
    await t.test(`${kind}: leave ${pending ? 'during capture' : 'before capture starts'}`, async () => {
      const consent = deferred(), initial = tracks(), replacement = tracks(kind === 'mic', kind === 'camera');
      const view = app([{ capture: (_options, count) => count === 1 ? Promise.resolve(initial) : consent.promise }]);
      try {
        await view.join();
        if (kind === 'mic') {
          initial[0].mediaStreamTrack.muted = true;
          initial[0].mediaStreamTrack.dispatchEvent(new Event('mute'));
        } else await view.button('Turn off camera').onClick();
        await flush(); view.render();
        const recovery = view.button(kind === 'mic' ? 'Turn on microphone' : 'Turn on camera').onClick();
        if (pending) {
          await flush();
          assert.equal(view.rooms[0].requests.length, 2);
        }
        await view.leave();
        consent.resolve(replacement); await recovery; await flush();
        assert.equal(view.rooms[0].requests.length, pending ? 2 : 1);
        assert.equal(view.rooms[0].localParticipant.trackPublications.size, 0);
        if (pending) assert.ok(replacement.every(track => track.mediaStreamTrack.readyState === 'ended'));
      } finally { view.dispose(); for (const track of replacement) track.stop(); }
    });
  }
});

test('old socket callbacks after rejoin preserve the new movie, clock and ping timer', async t => {
  const intervals = new Map(); let nextInterval = 0;
  const view = app([
    { capture: async () => tracks() },
    { capture: async () => tracks() },
  ], {
    setInterval(callback, delay) { const id = ++nextInterval; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
  });
  t.after(() => view.dispose());
  await view.join();
  const old = view.sockets[0]; old.readyState = 1; old.onopen();
  await view.leave(); await view.join();
  const current = view.sockets[1]; current.readyState = 1; current.onopen();
  const state = { type: 'state', movie: { id: 'current-movie', title: 'Current movie' }, participants: [], paused: true, position: 42, updatedAt: 8000, mediaVersion: 2 };
  current.onmessage({ data: JSON.stringify(state) });
  current.onmessage({ data: JSON.stringify({ type: 'pong', serverTime: Date.now() + 100, sent: Date.now() }) });
  view.render();
  const before = view.player(), ping = [...intervals.values()].find(timer => timer.delay === 10000);
  assert.ok(ping);
  old.onopen();
  old.onmessage({ data: JSON.stringify({ ...state, movie: { id: 'old-movie' }, position: 999, mediaVersion: 1 }) });
  old.onmessage({ data: JSON.stringify({ type: 'pong', serverTime: 0, sent: 0 }) });
  old.onclose(); view.render();
  assert.deepEqual(view.player().state, before.state);
  assert.equal(view.player().clockOffset, before.clockOffset);
  assert.equal(view.player().connectionVersion, before.connectionVersion);
  assert.deepEqual([...intervals.values()], [ping]);
  const sent = current.sent.length; ping.callback();
  assert.equal(current.sent.length, sent + 1);
});
