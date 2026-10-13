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
