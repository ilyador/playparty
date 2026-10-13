import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { playbackLogger, playbackMetrics } from '../server/playback-log.mjs';

test('playback telemetry accepts bounded measurements and excludes names, URLs and secrets', () => {
  const result = playbackMetrics({ event: 'waiting', drift: -2.34567, position: 40, bufferAhead: 0, readyState: 2, paused: false, name: 'private', url: 'https://private/?token=secret', token: 'secret', target: Infinity });
  assert.deepEqual(result, { event: 'waiting', position: 40, drift: -2.346, bufferAhead: 0, readyState: 2, paused: false });
  assert.equal(playbackMetrics({ event: 'private arbitrary event' }), null);
  assert.deepEqual(playbackMetrics({ event: 'microphone-status', microphoneEnabled: false, microphoneReadyState: 'live', echoCancellation: true, deviceId: 'private device', microphonePermission: 'granted' }), { event: 'microphone-status', microphoneEnabled: false, echoCancellation: true, microphonePermission: 'granted', microphoneReadyState: 'live' });
  assert.deepEqual(playbackMetrics({ event: 'capture-error', captureError: 'private arbitrary error', cameraPermission: 'private detail' }), { event: 'capture-error' });
  assert.deepEqual(playbackMetrics({ event: 'call-audio-output', callAudioTracks: 1, callAudioElements: 1, callAudioPlaying: 1, callAudioDuplicates: 0, callAudioUnexpected: 100, participant: 'private person', sid: 'private track' }), { event: 'call-audio-output', callAudioTracks: 1, callAudioElements: 1, callAudioPlaying: 1, callAudioDuplicates: 0 });
});

test('private playback files rotate with bounded retention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playparty-log-test-'));
  try {
    const filename = path.join(dir, 'playback.log');
    const log = playbackLogger(filename, { maxBytes: 180 });
    for (let i = 0; i < 30; i++) log({ event: 'sample', position: i });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['playback.log', 'playback.log.1', 'playback.log.2']);
    for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); assert.ok(fs.statSync(file).size <= 180); assert.equal(fs.statSync(file).mode & 0o777, 0o600); for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) assert.equal(JSON.parse(line).event, 'sample'); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
