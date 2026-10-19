import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';

const exports = {};
const code = ts.transpileModule(fs.readFileSync(new URL('../src/call-audio.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(code, { exports });
const { microphoneStatus, microphoneInterrupted, observeMicrophone, remoteCallAudio } = exports;

function nativeTrack() {
  const track = new EventTarget();
  Object.assign(track, { readyState: 'live', enabled: true, muted: false,
    getSettings: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: 'private-device', label: 'private-name' }),
  });
  return track;
}

function microphone() {
  const track = new EventEmitter();
  Object.assign(track, { mediaStreamTrack: nativeTrack(), isMuted: false, restarts: 0,
    async restartTrack() { this.restarts++; this.mediaStreamTrack = nativeTrack(); this.emit('restarted'); },
  });
  return track;
}

test('microphone diagnostics report native mute and applied processing without device identity', () => {
  const track = microphone();
  track.isMuted = true; track.mediaStreamTrack.enabled = false;
  assert.deepEqual(structuredClone(microphoneStatus(track)), {
    event: 'microphone-status', microphonePublished: true, microphoneReadyState: 'live',
    microphoneEnabled: false, microphoneMuted: false, microphoneUserMuted: true,
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  });
  assert.equal(microphoneInterrupted(track), false, 'An intentional microphone mute must not be treated as device failure.');
});

test('native interruption updates immediately and observer follows the replacement after SDK recovery', () => {
  const track = microphone(), samples = [];
  const original = track.mediaStreamTrack;
  const stop = observeMicrophone(track, sample => samples.push(structuredClone(sample)));
  original.muted = true; original.dispatchEvent(new Event('mute'));
  assert.equal(samples.at(-1).microphoneMuted, true);
  assert.equal(microphoneInterrupted(track), true);
  original.readyState = 'ended'; track.emit('ended');
  assert.equal(samples.at(-1).microphoneReadyState, 'ended');
  track.mediaStreamTrack = nativeTrack(); track.emit('restarted');
  assert.equal(samples.at(-1).microphoneReadyState, 'live');
  assert.equal(samples.at(-1).microphoneMuted, false);
  const count = samples.length;
  original.dispatchEvent(new Event('unmute'));
  assert.equal(samples.length, count, 'The replaced native track must no longer affect microphone status.');
  stop();
  track.mediaStreamTrack.dispatchEvent(new Event('mute')); track.emit('ended');
  assert.equal(samples.length, count);
});

function remoteAudioTrack(sid, children, source = 'microphone') {
  const track = new EventEmitter();
  Object.assign(track, { sid, kind: 'audio', source, attachments: 0, detachments: 0, attachedElements: [],
    attach() {
      this.attachments++;
      const element = new EventTarget();
      Object.assign(element, { paused: true, muted: false, remove() { children.delete(this); } });
      this.attachedElements.push(element);
      this.emit('elementAttached', element);
      return element;
    },
    detach(element) {
      this.detachments++;
      this.attachedElements.splice(this.attachedElements.indexOf(element), 1);
      this.emit('elementDetached', element);
    },
  });
  return track;
}

test('remote audio attaches once per track and replaces a SID without leaving duplicate playback', () => {
  const children = new Set();
  const container = { appendChild: element => children.add(element) };
  const audio = remoteCallAudio(container);
  const first = remoteAudioTrack('same-sid', children), replacement = remoteAudioTrack('same-sid', children);
  audio.attach(first); audio.attach(first);
  assert.equal(first.attachments, 1);
  assert.equal(children.size, 1);
  audio.attach(replacement);
  assert.equal(first.detachments, 1);
  assert.equal(children.size, 1);
  audio.detach(first);
  assert.equal(children.size, 1, 'A late unsubscribe cannot remove replacement audio.');
  audio.dispose();
  assert.equal(replacement.detachments, 1);
  assert.equal(children.size, 0);
});

test('output diagnostics detect duplicate publishers and out-of-band attachments without logging identities', () => {
  const children = new Set(), samples = [];
  const container = { appendChild: element => children.add(element) };
  const audio = remoteCallAudio(container, sample => samples.push(structuredClone(sample)));
  const first = remoteAudioTrack('private-track-a', children), second = remoteAudioTrack('private-track-b', children);
  const element = audio.attach(first, 'private-person');
  element.paused = false; element.dispatchEvent(new Event('playing'));
  assert.deepEqual(samples.at(-1), { event: 'call-audio-output', callAudioTracks: 1, callAudioElements: 1, callAudioPlaying: 1, callAudioDuplicates: 0, callAudioUnexpected: 0 });
  audio.attach(second, 'private-person');
  assert.equal(samples.at(-1).callAudioDuplicates, 1, 'Two publications from the same microphone must be detectable.');
  const extra = first.attach();
  assert.equal(samples.at(-1).callAudioElements, 3);
  assert.equal(samples.at(-1).callAudioDuplicates, 2, 'An extra element attached outside this helper must be detectable.');
  first.detach(extra);
  element.muted = true; element.dispatchEvent(new Event('volumechange'));
  assert.equal(samples.at(-1).callAudioPlaying, 0);
  audio.detach(second);
  assert.equal(samples.at(-1).callAudioDuplicates, 0);
  assert.ok(!JSON.stringify(samples).includes('private-'), 'Diagnostics must never include track or participant identities.');
  audio.dispose();
  assert.equal(samples.at(-1).callAudioTracks, 0);
  const count = samples.length;
  element.dispatchEvent(new Event('playing')); first.attach();
  assert.equal(samples.length, count, 'Disposed outputs must not keep diagnostic listeners.');
});

test('output diagnostics flag unexpected call audio sources', () => {
  const children = new Set(), samples = [];
  const audio = remoteCallAudio({ appendChild: element => children.add(element) }, sample => samples.push(structuredClone(sample)));
  audio.attach(remoteAudioTrack('private-screen-audio', children, 'screen_share_audio'), 'private-person');
  assert.equal(samples.at(-1).callAudioUnexpected, 1);
  audio.dispose();
});

const flush = () => new Promise(resolve => setImmediate(resolve));

// Safari on iPhone locks element volume (':volume-locked'). Audio may start
// only during a tap or while the microphone captures, modeled by allowAudio.
// Desktop Chrome/Firefox reject ':volume-locked' as an invalid selector.
function platform({ lockedVolume = true, refuse } = {}) {
  const children = new Set(), contexts = [];
  const state = { allowAudio: false, children, contexts };
  function element() {
    const media = new EventTarget();
    let muted = false;
    Object.assign(media, { paused: true, autoplay: false, srcObject: null, className: '',
      matches(selector) {
        if (!lockedVolume) throw new SyntaxError(`'${selector}' is not a valid selector.`);
        return selector === ':volume-locked';
      },
      play() {
        if (!state.allowAudio) return Promise.reject(new DOMException('Playback needs a tap.', 'NotAllowedError'));
        if (media.paused) { media.paused = false; queueMicrotask(() => media.dispatchEvent(new Event('playing'))); }
        return Promise.resolve();
      },
      pause() { if (!media.paused) { media.paused = true; queueMicrotask(() => media.dispatchEvent(new Event('pause'))); } },
      remove() { children.delete(media); },
    });
    Object.defineProperty(media, 'muted', { get: () => muted, set(value) {
      if (muted !== value) { muted = value; queueMicrotask(() => media.dispatchEvent(new Event('volumechange'))); }
    } });
    return media;
  }
  class MediaStream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  }
  class AudioNode {
    constructor(context, kind) { this.context = context; this.kind = kind; this.outputs = []; context.nodes.push(this); }
    connect(node) { this.outputs.push(node); return node; }
    disconnect() { this.outputs = []; }
  }
  const param = value => ({ value });
  class AudioContext extends EventTarget {
    constructor(options) {
      if (refuse === 'context') throw new DOMException('Too many audio contexts.', 'NotSupportedError');
      super(); this.options = options; this.state = 'suspended'; this.nodes = []; contexts.push(this);
      this.destination = new AudioNode(this, 'speakers');
    }
    set(next) { if (this.state !== next) { this.state = next; queueMicrotask(() => this.dispatchEvent(new Event('statechange'))); } }
    resume() {
      if (!state.allowAudio || this.state === 'interrupted' || this.state === 'closed') return Promise.reject(new DOMException('Audio needs a tap.', 'NotAllowedError'));
      this.set('running'); return Promise.resolve();
    }
    close() { this.set('closed'); return Promise.resolve(); }
    createGain() { return Object.assign(new AudioNode(this, 'gain'), { gain: param(1) }); }
    createDynamicsCompressor() {
      return Object.assign(new AudioNode(this, 'limiter'), { threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) });
    }
    createMediaStreamDestination() { return Object.assign(new AudioNode(this, 'stream'), { stream: new MediaStream([{ kind: 'audio' }]) }); }
    createMediaStreamSource(mediaStream) {
      if (refuse === 'source') throw new DOMException('The stream cannot be read.', 'InvalidStateError');
      return Object.assign(new AudioNode(this, 'voice'), { mediaStream }); }
  }
  const container = new EventTarget();
  container.appendChild = node => { children.add(node); return node; };
  const instance = {};
  vm.runInNewContext(code, { exports: instance, AudioContext, MediaStream, document: { createElement: () => element() } });
  function track(sid) {
    const remote = new EventEmitter();
    Object.assign(remote, { sid, kind: 'audio', source: 'microphone', attachedElements: [],
      mediaStreamTrack: { kind: 'audio', id: `${sid}-media`, readyState: 'live' },
      // LiveKit plays each attached element right away to detect autoplay.
      attach() {
        const media = element(); media.srcObject = new MediaStream([this.mediaStreamTrack]); media.play().catch(() => {});
        this.attachedElements.push(media); this.emit('elementAttached', media); return media;
      },
      detach(media) { this.attachedElements.splice(this.attachedElements.indexOf(media), 1); this.emit('elementDetached', media); },
    });
    return remote;
  }
  return Object.assign(state, { container, track, remoteCallAudio: instance.remoteCallAudio });
}

test('iPhone voices stay direct until Safari allows the boosted mix, which then replaces them', async () => {
  const iphone = platform(), samples = [];
  const audio = iphone.remoteCallAudio(iphone.container, sample => samples.push(structuredClone(sample)));
  const direct = audio.attach(iphone.track('private-voice'), 'private-person');
  await flush();
  assert.equal(direct.muted, false, 'Voices must stay audible while Safari blocks the boosted mix.');
  assert.equal(samples.at(-1).callAudioBoosted, false);
  iphone.allowAudio = true; // The microphone now captures, so Safari lets call audio start.
  await direct.play(); await flush(); // Room.startAudio() after capture starts.
  const output = [...iphone.children].find(node => node !== direct);
  assert.equal(output.paused, false);
  assert.equal(direct.muted, true, 'The direct copy must not double the boosted voice.');
  assert.equal(samples.at(-1).callAudioBoosted, true);
  assert.ok(!JSON.stringify(samples).includes('private-'));
  audio.dispose();
});

test('boosted voices are raised, limited, and kept on MediaStream call audio', async () => {
  const iphone = platform(); iphone.allowAudio = true;
  const audio = iphone.remoteCallAudio(iphone.container);
  const voice = iphone.track('private-voice');
  const direct = audio.attach(voice);
  await flush();
  const [context] = iphone.contexts;
  const source = context.nodes.find(node => node.kind === 'voice');
  assert.deepEqual(source.mediaStream.getAudioTracks(), [voice.mediaStreamTrack]);
  const route = [];
  for (let node = source; node; node = node.outputs[0]) route.push(node);
  assert.deepEqual(route.map(node => node.kind), ['voice', 'gain', 'limiter', 'stream']);
  assert.ok(route[1].gain.value > 1, 'Voices must be raised above their direct level.');
  const output = [...iphone.children].find(node => node !== direct);
  assert.equal(output.srcObject, route[3].stream, 'Safari echo-cancels MediaStream audio played by an element.');
  assert.ok(context.nodes.every(node => !node.outputs.includes(context.destination)), 'Web Audio speakers bypass call echo cancellation.');
  audio.dispose();
});

test('voices fall back to direct playback whenever the boosted mix stops', async () => {
  const iphone = platform(), samples = [];
  iphone.allowAudio = true;
  const audio = iphone.remoteCallAudio(iphone.container, sample => samples.push(structuredClone(sample)));
  const direct = audio.attach(iphone.track('private-voice'));
  await flush();
  assert.equal(direct.muted, true);
  const [context] = iphone.contexts;
  context.set('interrupted'); await flush();
  assert.equal(direct.muted, false, 'An interrupted mix must not leave the call silent.');
  assert.equal(samples.at(-1).callAudioBoosted, false);
  context.set('running'); await flush();
  assert.equal(direct.muted, true);
  const output = [...iphone.children].find(node => node !== direct);
  iphone.allowAudio = false; output.pause(); await flush();
  assert.equal(direct.muted, false, 'A paused mix must not leave the call silent.');
  audio.dispose();
});

test('LiveKit restarting direct playback cannot double a boosted voice', async () => {
  const iphone = platform(); iphone.allowAudio = true;
  const audio = iphone.remoteCallAudio(iphone.container);
  const direct = audio.attach(iphone.track('private-voice'));
  await flush();
  direct.muted = false; await direct.play(); await flush(); // Room.startAudio() unmutes attached elements.
  assert.equal(direct.muted, true);
  audio.dispose();
});

test('a tap starts a boosted mix that Safari blocked', async () => {
  const iphone = platform();
  const audio = iphone.remoteCallAudio(iphone.container);
  const direct = audio.attach(iphone.track('private-voice'));
  await flush();
  assert.equal(direct.muted, false);
  iphone.allowAudio = true; iphone.container.dispatchEvent(new Event('touchend')); await flush();
  assert.equal(direct.muted, true);
  audio.dispose();
});

test('voices share one boosted mix, leave it when detached, and disposal releases it', async () => {
  const iphone = platform(); iphone.allowAudio = true;
  const audio = iphone.remoteCallAudio(iphone.container);
  const first = iphone.track('private-a'), second = iphone.track('private-b');
  const direct = audio.attach(first); audio.attach(second);
  await flush();
  assert.equal(iphone.contexts.length, 1);
  const [context] = iphone.contexts;
  const sources = context.nodes.filter(node => node.kind === 'voice');
  assert.equal(sources.length, 2);
  audio.detach(first);
  assert.deepEqual(sources[0].outputs, [], 'A detached voice must leave the mix.');
  assert.equal(iphone.children.has(direct), false);
  audio.dispose(); await flush();
  assert.equal(context.state, 'closed');
  assert.equal(iphone.children.size, 0, 'Disposal removes the boosted output too.');
});

test('adjustable volume keeps direct LiveKit playback without Web Audio', async () => {
  const desktop = platform({ lockedVolume: false }), samples = [];
  desktop.allowAudio = true;
  const audio = desktop.remoteCallAudio(desktop.container, sample => samples.push(structuredClone(sample)));
  const direct = audio.attach(desktop.track('private-voice'));
  await flush();
  assert.equal(desktop.contexts.length, 0, 'Desktop call audio must not change.');
  assert.equal(direct.muted, false);
  assert.equal(desktop.children.size, 1);
  assert.ok(samples.every(sample => !('callAudioBoosted' in sample)));
  audio.dispose();
});

test('call audio stays direct when Safari refuses any part of the boosted mix', async () => {
  for (const refuse of ['context', 'source']) {
    const iphone = platform({ refuse }); iphone.allowAudio = true;
    const audio = iphone.remoteCallAudio(iphone.container);
    const direct = audio.attach(iphone.track('private-voice'));
    await flush();
    assert.equal(direct.muted, false, `${refuse}: voices must keep playing directly.`);
    assert.ok(iphone.children.has(direct));
    audio.dispose();
  }
});
