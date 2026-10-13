import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveQuality } from '../src/adaptive-quality.ts';

function setup(configuration = {}) {
  let time = 0;
  const changes = [];
  const controller = createAdaptiveQuality({ remote: true, maxBitrate: 50000, ...configuration, now: () => time,
    onChange: (bitrate, reason) => changes.push({ bitrate, reason }) });
  return { controller, changes, at: value => { time = value; } };
}
const playing = { playing: true, seeking: false, stalled: false, bufferAhead: 4 };

test('a stable low bitrate original remains at full quality without an artificial downgrade', () => {
  const { controller, changes, at } = setup();
  for (let seconds = 2; seconds <= 180; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 300000, downloadMs: 500, duration: 2, bufferAhead: 12 });
    controller.sample({ ...playing, bufferAhead: 12 });
  }
  assert.deepEqual(changes, []);
});

test('sustained slow fragments and a depleted buffer select a cap supported by the connection', () => {
  const { controller, changes, at } = setup();
  for (let seconds = 3; seconds <= 9; seconds += 3) {
    at(seconds * 1000);
    controller.fragment({ bytes: 1000000, downloadMs: 3000, duration: 2, bufferAhead: 3 });
    controller.sample(playing);
  }
  assert.deepEqual(changes, [{ bitrate: 1500, reason: 'bandwidth' }]);
  at(15000);
  controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  assert.equal(changes.length, 1, 'A pending replacement cannot trigger another request.');
});

test('pause, seek, startup and a transient wait do not cause quality changes', () => {
  const { controller, changes, at } = setup();
  for (const time of [0, 1000, 5000]) {
    at(time); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  }
  at(6000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  at(9000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  at(10000); controller.sample({ ...playing, playing: false, stalled: true, bufferAhead: 0 });
  at(30000); controller.sample({ ...playing, playing: false, stalled: true, bufferAhead: 0 });
  at(31000); controller.sample({ ...playing, seeking: true, stalled: true, bufferAhead: 0 });
  at(50000); controller.sample(playing);
  assert.deepEqual(changes, []);
});

test('sustained playback stalls reduce resolution budget and cooldown prevents rapid retries', () => {
  const { controller, changes, at } = setup();
  at(6000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  at(11000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  assert.deepEqual(changes, [{ bitrate: 8000, reason: 'stall' }]);
  controller.configure({ remote: true, maxBitrate: 50000, currentBitrate: 8000 });
  at(17000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  at(22000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  assert.equal(changes.length, 1);
  at(32000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  assert.deepEqual(changes[1], { bitrate: 4000, reason: 'stall' });
});

test('recovery needs a full minute of healthy buffer and capacity, then raises one step', () => {
  const { controller, changes, at } = setup({ currentBitrate: 4000 });
  for (let seconds = 6; seconds <= 66; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 2000000, downloadMs: 250, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
    if (seconds < 66) assert.equal(changes.length, 0);
  }
  assert.deepEqual(changes, [{ bitrate: 6000, reason: 'recovery' }]);
});

test('local devices ignore bandwidth pressure and stalls', () => {
  const { controller, changes, at } = setup({ remote: false });
  for (let seconds = 0; seconds < 120; seconds += 3) {
    at(seconds * 1000);
    controller.fragment({ bytes: 1000000, downloadMs: 3000, duration: 2, bufferAhead: 0 });
    controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  }
  assert.deepEqual(changes, []);
});
