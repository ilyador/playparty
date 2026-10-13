import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { DisconnectReason, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, Track, setLogLevel } from 'livekit-client';

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
function app(plans, timers = { setInterval, clearInterval }, initialState, session = () => ({ canHost: false })) {
  const slots = [], effects = [], rooms = [], sockets = [], requests = [], joins = [], audioOutputs = new Set();
  let cursor = 0, tree, identity = 0;
  const events = new EventTarget();
  const movie = { paused: false, pauses: 0, pause() { this.paused = true; this.pauses++; } };
  const document = { body: { appendChild(element) { audioOutputs.add(element); } }, fullscreenElement: null, visibilityState: 'visible',
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
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
      this.disconnections = (this.disconnections || 0) + 1;
      for (const pub of this.localParticipant.trackPublications.values()) void this.localParticipant.unpublishTrack(pub.track);
      this.emit(RoomEvent.Disconnected);
      return Promise.resolve();
    }
  }
  const state = initialState || { movie: null, participants: [], hostPresent: false };
  const App = module('App.tsx', {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    'livekit-client': { Room: CallRoom, RoomEvent, Track, AudioPresets: {}, VideoPresets: {} },
    '@phosphor-icons/react': {}, './Call': {}, './Library': {}, './Player': { default: 'player' },
    './call-capture': capture, './call-audio': audio, './movie-element': { createMovieElement: () => movie },
    './types': {
      contentTitle: content => content.title,
      api: async (_path, options) => ({ state, ...await session(options?.signal) }),
      post: async (path, body) => { requests.push(path); if (path === 'join') joins.push(body); return path === 'join' ? { identity: `person-${++identity}`, name: 'Test', owner: false, state, livekitUrl: '', token: '' } : {}; },
    },
  }, {
    localStorage: { getItem: () => 'Test', setItem() {} }, location: { search: '', protocol: 'http:', host: 'localhost' },
    window: { addEventListener() {}, removeEventListener() {} },
    document, performance,
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
    rooms, sockets, render, movie, requests, joins, audioOutputs,
    hostChoice: () => find(node => node.type === 'input' && node.props.id === 'host', tree)?.props,
    hostLogin: () => find(node => node.type === 'a' && node.props.className === 'host-login-link', tree)?.props,
    hostBusy: () => find(node => node.props?.id === 'host-busy', tree)?.props,
    visibility(value) { document.visibilityState = value; events.dispatchEvent(new Event('visibilitychange')); render(); },
    player: () => find(node => node.type === 'player', tree)?.props,
    button: label => find(node => node.type === 'button' && node.props['aria-label'] === label, tree).props,
    notice: () => find(node => node.props?.className === 'notice', tree)?.props.children[0].props.children,
    joinError: () => find(node => node.props?.className === 'inline-error', tree)?.props.children,
    async join() { await find(node => node.type === 'form', tree).props.onSubmit({ preventDefault() {} }); render(); await flush(); render(); },
    async leave() { await this.button('Leave the call').onClick(); render(); await flush(); render(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function clock() {
  let now = 0, next = 0;
  const scheduled = new Map();
  const schedule = (callback, delay, repeat) => {
    const id = ++next;
    scheduled.set(id, { callback, delay, repeat, due: now + delay });
    return id;
  };
  return {
    performance: { now: () => now },
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: id => scheduled.delete(id),
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    clearTimeout: id => scheduled.delete(id),
    get scheduled() { return [...scheduled.values()]; },
    advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const next = [...scheduled].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.due;
        if (timer.repeat) timer.due += timer.delay;
        else scheduled.delete(id);
        timer.callback();
      }
      now = end;
    },
  };
}
const movieState = { type: 'state', movie: { id: 'current-movie', title: 'Current movie' }, participants: [], paused: false, position: 42, updatedAt: 8000, mediaVersion: 2 };
const open = socket => { socket.readyState = 1; socket.onopen(); };
const receive = (socket, state = movieState) => socket.onmessage({ data: JSON.stringify(state) });

test('host choice stays hidden during discovery and clears when Plex access is lost', async t => {
  const timer = clock(), initial = deferred();
  let discovery = () => initial.promise;
  const view = app([{ capture: async () => tracks() }], timer, undefined, () => discovery());
  t.after(() => view.dispose());
  assert.equal(view.hostChoice(), undefined, 'Loading must not briefly expose the host switch.');
  initial.resolve({ canHost: true }); await flush(); view.render();
  assert.equal(view.hostChoice().checked, false, 'A regular visitor is never automatically made host.');
  view.hostChoice().onChange({ target: { checked: true } }); view.render();
  assert.equal(view.hostChoice().checked, true);
  discovery = async () => ({ canHost: false }); timer.advance(5000); await flush(); view.render();
  assert.equal(view.hostChoice(), undefined);
  discovery = async () => ({ canHost: true }); timer.advance(5000); await flush(); view.render();
  assert.equal(view.hostChoice().checked, false, 'Recovered access must not restore a stale host selection.');
  await view.join();
  assert.equal(view.joins[0].host, false);
});

test('an active party disables host choice and retirement restores an unchecked switch', async t => {
  const timer = clock();
  let session = { canHost: true, hostBusy: false };
  const view = app([{ capture: async () => tracks() }], timer, undefined, async () => session);
  t.after(() => view.dispose());
  await flush(); view.render();
  view.hostChoice().onChange({ target: { checked: true } }); view.render();
  session = { canHost: false, hostBusy: true };
  timer.advance(5000); await flush(); view.render();
  assert.equal(view.hostChoice().disabled, true);
  assert.equal(view.hostChoice().checked, false);
  assert.equal(view.hostChoice()['aria-describedby'], 'host-busy');
  assert.equal(view.hostBusy().children, 'There is already an active session.');
  assert.equal(view.hostLogin(), undefined, 'A busy party does not request another sign-in.');
  session = { canHost: true, hostBusy: false };
  timer.advance(5000); await flush(); view.render();
  assert.equal(view.hostChoice().disabled, false);
  assert.equal(view.hostChoice().checked, false);
  assert.equal(view.hostBusy(), undefined);
  await view.join();
  assert.equal(view.joins[0].host, false, 'Retirement never restores a stale host request.');
});

test('external login stays in the app and disappears after its own session is authenticated', async t => {
  const timer = clock();
  let session = { canHost: false, loginUrl: '/login' };
  const view = app([], timer, undefined, async () => session);
  t.after(() => view.dispose());
  await flush(); view.render();
  assert.equal(view.hostChoice(), undefined);
  assert.equal(view.hostLogin().href, '/login');
  assert.equal(view.hostLogin().target, undefined, 'Home Screen login uses the app’s existing window and cookie store.');
  session = { canHost: true, loginUrl: undefined };
  timer.advance(5000); await flush(); view.render();
  assert.equal(view.hostLogin(), undefined);
  assert.equal(view.hostChoice().checked, false);
  session = { canHost: false, loginUrl: undefined };
  timer.advance(5000); await flush(); view.render();
  assert.equal(view.hostChoice(), undefined);
  assert.equal(view.hostLogin(), undefined, 'An unavailable server does not suggest an unrelated sign-in.');
});

test('failed discovery removes host choice and overlapping refreshes cannot overwrite newer access', async t => {
  const timer = clock(), delayed = deferred();
  let calls = 0, discovery = async () => ({ canHost: true });
  const view = app([{ capture: async () => tracks() }], timer, undefined, () => { calls++; return discovery(); });
  t.after(() => view.dispose());
  await flush(); view.render();
  view.hostChoice().onChange({ target: { checked: true } }); view.render();
  discovery = () => delayed.promise;
  timer.advance(15000);
  assert.equal(calls, 2, 'Only one discovery refresh may remain in flight.');
  delayed.reject(new Error('Offline')); await flush(); view.render();
  assert.equal(view.hostChoice(), undefined);
  await view.join();
  assert.equal(view.joins[0].host, false, 'A hidden stale switch cannot submit a host request.');
});

test('a hung initial discovery times out and the next check restores the host option', async t => {
  const timer = clock();
  let requests = 0, cancelled = false;
  const view = app([], timer, undefined, signal => {
    if (++requests > 1) return Promise.resolve({ canHost: true });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled = true;
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true }));
  });
  t.after(() => view.dispose());
  timer.advance(5000); await flush(); view.render();
  assert.equal(requests, 1, 'A slow request is not duplicated.');
  assert.equal(view.hostChoice(), undefined);
  timer.advance(3000); await flush(); view.render();
  assert.equal(cancelled, true, 'Discovery cannot block every later check indefinitely.');
  assert.match(view.joinError(), /unavailable/);
  timer.advance(2000); await flush(); view.render();
  assert.equal(requests, 2);
  assert.equal(view.hostChoice().checked, false, 'Fresh verified access renders the host option without selecting it.');
  assert.equal(view.joinError(), undefined, 'Successful discovery clears its earlier network warning.');
});

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
  assert.equal(view.notice(), 'The call disconnected. Leave and rejoin to reconnect.');
});

test('terminal removal or state mismatch explains rejoining while transient call reconnect preserves capture', async t => {
  for (const reason of [DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.STATE_MISMATCH]) await t.test(DisconnectReason[reason], async () => {
    const initial = tracks(), view = app([{ capture: async () => initial }]);
    try {
      await view.join();
      view.rooms[0].emit(RoomEvent.Reconnecting); view.render();
      assert.equal(view.notice(), undefined);
      assert.ok(initial.every(track => track.mediaStreamTrack.readyState === 'live'));
      view.rooms[0].emit(RoomEvent.Reconnected); view.render();
      assert.equal(view.notice(), undefined);
      view.rooms[0].emit(RoomEvent.Disconnected, reason); await flush(); view.render();
      assert.equal(view.notice(), 'The call disconnected. Leave and rejoin to reconnect.');
      assert.equal(view.button('Mute microphone').disabled, true);
      assert.ok(initial.every(track => track.mediaStreamTrack.readyState === 'ended'));
      assert.deepEqual(view.requests, ['join'], 'A terminal call disconnect cannot automatically mutate the shared session.');
    } finally { view.dispose(); }
  });
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
  const timer = clock();
  const view = app([
    { capture: async () => tracks() },
    { capture: async () => tracks() },
  ], timer);
  t.after(() => view.dispose());
  await view.join();
  const old = view.sockets[0]; old.readyState = 1; old.onopen();
  await view.leave(); await view.join();
  const current = view.sockets[1]; current.readyState = 1; current.onopen();
  const state = { type: 'state', movie: { id: 'current-movie', title: 'Current movie' }, participants: [], paused: true, position: 42, updatedAt: 8000, mediaVersion: 2 };
  current.onmessage({ data: JSON.stringify(state) });
  current.onmessage({ data: JSON.stringify({ type: 'pong', serverTime: Date.now() + 100, sent: Date.now() }) });
  view.render();
  const before = view.player(), heartbeat = timer.scheduled.find(timer => timer.delay === 2000);
  assert.ok(heartbeat);
  old.onopen();
  old.onmessage({ data: JSON.stringify({ ...state, movie: { id: 'old-movie' }, position: 999, mediaVersion: 1 }) });
  old.onmessage({ data: JSON.stringify({ type: 'pong', serverTime: 0, sent: 0 }) });
  old.onclose({ code: 4001 }); view.render();
  assert.deepEqual(view.player().state, before.state);
  assert.equal(view.player().clockOffset, before.clockOffset);
  assert.equal(view.player().connectionVersion, before.connectionVersion);
  assert.deepEqual(timer.scheduled, [heartbeat]);
  const sent = current.sent.length;
  timer.advance(6000); receive(current, state); timer.advance(4000);
  assert.equal(current.sent.length, sent + 1);
});

test('a superseded tab ends only its local call, never leaves the shared session, and can intentionally rejoin', async t => {
  const timer = clock(), initial = tracks(), replacement = tracks();
  const view = app([{ capture: async () => initial }, { capture: async () => replacement }], timer, movieState);
  t.after(() => view.dispose());
  await view.join();
  const old = view.sockets[0]; open(old); receive(old); view.render();
  assert.equal(view.rooms[0].requests.length, 1);
  old.readyState = 3; old.onclose({ code: 4001 }); view.render(); await flush(); view.render();
  assert.equal(view.joinError(), 'You joined in another tab.');
  assert.equal(view.player(), undefined, 'A superseded tab returns to the name form.');
  assert.equal(view.movie.paused, true);
  assert.ok(initial.every(track => track.mediaStreamTrack.readyState === 'ended'));
  assert.equal(view.rooms[0].disconnections, 1);
  assert.deepEqual(view.requests, ['join'], 'The old tab cannot send Leave with the replacement tab’s shared cookie.');
  timer.advance(20000); view.render();
  assert.equal(view.sockets.length, 1, 'A superseded tab must not retry the state connection.');
  await view.join();
  const current = view.sockets[1]; open(current); receive(current); view.render();
  assert.equal(view.joinError(), undefined);
  assert.equal(view.player().stateFresh, true);
  assert.ok(replacement.every(track => track.mediaStreamTrack.readyState === 'live'));
  old.onclose({ code: 4001 }); view.render();
  assert.equal(view.player().stateFresh, true, 'An old terminal close cannot evict a deliberately rejoined call.');
});

test('expired party membership ends live SDK capture and call audio even after foreground socket replacement', async t => {
  for (const foreground of [false, true]) await t.test(foreground ? 'foreground replaced the expired socket' : 'current socket expires', async () => {
    const timer = clock(), initial = tracks(), replacement = tracks();
    const view = app([{ capture: async () => initial }, { capture: async () => replacement }], timer, movieState);
    try {
      await view.join();
      const old = view.sockets[0]; open(old); receive(old); view.render();
      // Exercise App's actual remote-output owner; the media element stands in
      // for a browser audio element, while local capture uses installed SDK tracks.
      const remote = new EventEmitter();
      Object.assign(remote, { kind: 'audio', source: Track.Source.Microphone, sid: 'remote-audio', attachedElements: [],
        attach() { const element = new EventTarget(); Object.assign(element, { paused: false, muted: false, remove: () => view.audioOutputs.delete(element) }); this.attachedElements.push(element); return element; },
        detach(element) { this.attachedElements = this.attachedElements.filter(attached => attached !== element); return [element]; },
      });
      view.rooms[0].emit(RoomEvent.TrackSubscribed, remote, {}, { identity: 'remote' });
      assert.equal(view.audioOutputs.size, 1);
      let expired = old;
      if (foreground) {
        view.visibility('hidden'); view.visibility('visible');
        expired = view.sockets[1]; open(expired);
        old.onclose({ code: 4002 }); view.render();
        assert.equal(view.joinError(), undefined, 'A late old close cannot evict a replacement before it proves its session expired.');
        assert.ok(initial.every(track => track.mediaStreamTrack.readyState === 'live'));
      }
      expired.readyState = 3; expired.onclose({ code: 4002 }); view.render(); await flush(); view.render();
      assert.equal(view.joinError(), 'Your session expired. Join again to reconnect.');
      assert.equal(view.player(), undefined, 'An expired session must return to the name form.');
      assert.equal(view.movie.paused, true);
      assert.ok(initial.every(track => track.mediaStreamTrack.readyState === 'ended'), 'Terminal party expiry must stop native capture independently of a LiveKit event.');
      assert.equal(view.rooms[0].disconnections, 1);
      assert.equal(view.audioOutputs.size, 0, 'Terminal expiry must detach every managed remote call-audio output.');
      assert.deepEqual(view.requests, ['join'], 'Terminal expiry cannot send Leave using a potentially replaced shared cookie.');
      const count = view.sockets.length;
      timer.advance(20000); view.render();
      assert.equal(view.sockets.length, count, 'Expired membership must stop reconnect loops.');
      await view.join();
      const current = view.sockets.at(-1); open(current); receive(current); view.render();
      assert.equal(view.joinError(), undefined);
      assert.equal(view.player().stateFresh, true);
      assert.equal(view.rooms[1].requests.length, 1, 'An explicit rejoin must use one fresh combined device capture.');
      assert.ok(replacement.every(track => track.mediaStreamTrack.readyState === 'live'));
      old.onclose({ code: 4002 }); expired.onclose({ code: 4002 }); old.onmessage({ data: JSON.stringify({ ...movieState, position: 999 }) }); view.render();
      assert.equal(view.player().stateFresh, true, 'Old terminal callbacks cannot evict the deliberately rejoined call.');
      assert.equal(view.player().state.position, 42);
      assert.ok(replacement.every(track => track.mediaStreamTrack.readyState === 'live'));
    } finally { view.dispose(); }
  });
});

test('the state watchdog is local-only while snapshots arrive and keeps the existing ten-second ping', async t => {
  const timer = clock(), view = app([{ capture: async () => tracks() }], timer, movieState);
  t.after(() => view.dispose());
  await view.join();
  const socket = view.sockets[0]; open(socket); view.render();
  assert.equal(view.player().stateFresh, false, 'Opening a transport does not establish timeline freshness.');
  receive(socket); view.render();
  assert.equal(view.player().stateFresh, true);
  const generation = view.player().connectionVersion;
  const initialPings = socket.sent.filter(message => message.type === 'ping').length;
  for (let i = 0; i < 10; i++) { timer.advance(2000); receive(socket); view.render(); }
  assert.equal(view.sockets.length, 1);
  assert.equal(view.player().connectionVersion, generation, 'Ordinary snapshots must not repeatedly clear player readiness.');
  assert.equal(socket.sent.filter(message => message.type === 'ping').length, initialPings + 2);
  assert.equal(view.rooms.length, 1);
  assert.equal(view.rooms[0].requests.length, 1);
});

test('queued and invalid pongs cannot poison the playback clock, and reconnect resets the RTT baseline', async t => {
  const timer = clock();
  let now = 110000;
  const view = app([{ capture: async () => tracks() }], { ...timer, Date: { now: () => now } }, movieState);
  t.after(() => view.dispose());
  await view.join();
  const first = view.sockets[0]; open(first); receive(first); view.render();
  const pong = (socket, rtt, offset) => {
    receive(socket, { type: 'pong', sent: now - rtt, serverTime: now - rtt / 2 + offset });
    view.render();
  };
  pong(first, 5033, 2516.5);
  assert.equal(view.player().clockOffset, 0, 'Even a connection’s first queued outage pong must be ignored.');
  pong(first, 20, 200);
  assert.equal(view.player().clockOffset, 200);
  pong(first, 5033, 2516.5);
  assert.equal(view.player().clockOffset, 200, 'A retained WebSocket’s five-second queued pong cannot replace its healthy clock.');
  pong(first, 121, 999);
  assert.equal(view.player().clockOffset, 200, 'A slower sample outside the best RTT allowance must be ignored even below the absolute limit.');
  pong(first, 120, 210);
  assert.equal(view.player().clockOffset, 210, 'Small network jitter can still refresh the estimate.');
  for (const invalid of [
    { sent: now + 1, serverTime: now },
    { sent: '110000', serverTime: now },
    { sent: now, serverTime: '110000' },
    { sent: null, serverTime: now },
    { sent: now, serverTime: NaN },
    { sent: now, serverTime: Infinity },
    { serverTime: now },
  ]) {
    receive(first, { type: 'pong', ...invalid }); view.render();
    assert.equal(view.player().clockOffset, 210, 'Nonfinite, nonnumeric or future timestamps cannot change the clock.');
  }
  const initialPings = first.sent.filter(message => message.type === 'ping').length;
  for (let index = 0; index < 5; index++) { now += 2000; timer.advance(2000); receive(first); view.render(); }
  assert.equal(first.sent.filter(message => message.type === 'ping').length, initialPings + 1, 'Filtering clock samples must retain the existing ten-second ping cadence.');
  view.visibility('hidden'); view.visibility('visible');
  const second = view.sockets[1]; open(second); receive(second); view.render();
  pong(second, 5033, 2516.5);
  assert.equal(view.player().clockOffset, 210, 'A reconnect retains the last healthy estimate while an initial queued sample is rejected.');
  pong(second, 250, 300);
  assert.equal(view.player().clockOffset, 300, 'The replacement socket must establish a fresh baseline for a legitimately slower path.');
  pong(second, 5, 280);
  assert.equal(view.player().clockOffset, 280, 'A new low-latency sample must refine the replacement connection’s estimate.');
  pong(first, 1, 999);
  assert.equal(view.player().clockOffset, 280, 'An old socket’s pong must still be ignored.');
  pong(second, 106, 999);
  assert.equal(view.player().clockOffset, 280, 'The new connection’s lower RTT must tighten its allowance.');
  assert.equal(view.rooms.length, 1, 'Clock repair must keep the existing call and native capture.');
  assert.equal(view.rooms[0].requests.length, 1);
});

test('a silent open socket pauses the movie and replaces only party transport after eight seconds', async t => {
  const timer = clock(), initial = tracks(), view = app([{ capture: async () => initial }], timer, movieState);
  t.after(() => view.dispose());
  await view.join();
  const old = view.sockets[0]; open(old); receive(old); view.render();
  const generation = view.player().connectionVersion;
  view.movie.paused = false;
  timer.advance(6000); view.render();
  assert.equal(view.sockets.length, 1);
  assert.equal(view.player().stateFresh, true);
  timer.advance(2000); view.render();
  assert.equal(view.movie.paused, true);
  assert.equal(view.player().stateFresh, false);
  assert.equal(old.readyState, 3);
  assert.equal(view.sockets.length, 2);
  assert.equal(view.rooms.length, 1, 'Recovering movie transport must retain the video call.');
  assert.equal(view.rooms[0].disconnections || 0, 0);
  assert.ok(initial.every(track => track.mediaStreamTrack.readyState === 'live'));
  const replacement = view.sockets[1]; open(replacement); view.render();
  assert.equal(view.player().stateFresh, false);
  old.onmessage({ data: JSON.stringify({ ...movieState, position: 999 }) }); old.onclose(); view.render();
  assert.equal(view.player().state.position, 42);
  assert.equal(view.player().connectionVersion, generation);
  receive(replacement, { ...movieState, position: 50 }); view.render();
  assert.equal(view.player().stateFresh, true);
  assert.equal(view.player().state.position, 50);
  assert.equal(view.player().connectionVersion, generation + 1);
  timer.advance(1500);
  assert.equal(view.sockets.length, 2, 'A replaced socket close callback must not leave an extra reconnect scheduled.');
});

test('missing initial state times out even when pongs arrive or the socket never opens', async t => {
  for (const opened of [false, true]) await t.test(opened ? 'open without state' : 'connecting', async () => {
    const timer = clock(), view = app([{ capture: async () => tracks() }], timer, movieState);
    try {
      await view.join();
      const socket = view.sockets[0];
      if (opened) { open(socket); receive(socket, { type: 'pong', serverTime: 100, sent: 0 }); }
      timer.advance(8000); view.render();
      assert.equal(view.sockets.length, 2);
      assert.equal(view.player().stateFresh, false);
      assert.equal(view.movie.paused, true);
      timer.advance(6000);
      assert.equal(view.sockets.length, 2, 'Every replacement gets its own full freshness timeout.');
      timer.advance(2000);
      assert.equal(view.sockets.length, 3);
      assert.equal(view.rooms.length, 1);
    } finally { view.dispose(); }
  });
});

test('foreground refresh replaces party transport immediately without losing the call or queued cleanup', async t => {
  const timer = clock(), initial = tracks(), view = app([{ capture: async () => initial }], timer, movieState);
  t.after(() => view.dispose());
  await view.join();
  const first = view.sockets[0]; open(first); receive(first); view.render();
  view.visibility('hidden');
  assert.equal(view.sockets.length, 1, 'Backgrounding alone must not reconnect or leave the call.');
  view.movie.paused = false;
  view.visibility('visible');
  assert.equal(view.movie.paused, true);
  assert.equal(view.player().stateFresh, false);
  assert.equal(view.sockets.length, 2);
  const second = view.sockets[1]; open(second); receive(second); view.render();
  second.readyState = 3; second.onclose(); view.render();
  assert.equal(view.player().stateFresh, false);
  view.visibility('visible');
  assert.equal(view.sockets.length, 3, 'Foregrounding should immediately replace a scheduled delayed reconnect.');
  const third = view.sockets[2]; open(third); receive(third);
  timer.advance(1500);
  assert.equal(view.sockets.length, 3);
  assert.equal(view.rooms[0].disconnections || 0, 0);
  assert.ok(initial.every(track => track.mediaStreamTrack.readyState === 'live'));
  await view.leave();
  const count = view.sockets.length;
  view.visibility('visible'); timer.advance(20000);
  assert.equal(view.sockets.length, count, 'Leave must remove foreground handling and its watchdog timer.');
  assert.ok(initial.every(track => track.mediaStreamTrack.readyState === 'ended'));
});
