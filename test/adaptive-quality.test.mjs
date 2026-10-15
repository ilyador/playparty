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

test('a compatibility replacement at the same quality gets a fresh startup grace', () => {
  const { controller, changes, at } = setup();
  at(6000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  at(10000); controller.configure({ remote: true, maxBitrate: 50000, currentBitrate: 50000 });
  at(14000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  at(16000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  at(20000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  assert.deepEqual(changes, [], 'Old-source stall history cannot downgrade a replacement before it starts.');
  at(21000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  assert.equal(changes.length, 1, 'A genuinely stalled replacement can still adapt after its own grace.');
});

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
  assert.deepEqual(changes, [{ bitrate: 2266, reason: 'bandwidth' }]);
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

test('sustained playback stalls use a live capacity hint and cooldown prevents rapid retries', () => {
  const { controller, changes, at } = setup();
  at(6000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 11900 });
  at(11000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 11900 });
  assert.deepEqual(changes, [{ bitrate: 11900, reason: 'stall' }]);
  controller.configure({ remote: true, maxBitrate: 50000, currentBitrate: 11900 });
  at(17000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  at(22000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  assert.equal(changes.length, 1);
  at(32000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  assert.deepEqual(changes[1], { bitrate: 8925, reason: 'stall' });
});

test('recovery needs a full minute of healthy buffer and capacity, then restores supported quality directly', () => {
  const { controller, changes, at } = setup({ currentBitrate: 4000 });
  for (let seconds = 6; seconds <= 66; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 2000000, downloadMs: 250, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
    if (seconds < 66) assert.equal(changes.length, 0);
  }
  assert.deepEqual(changes, [{ bitrate: 50000, reason: 'recovery' }]);
});

test('a five-viewer fallback does not cap healthy initial playback and only affects the stalled viewer', () => {
  const viewers = Array.from({ length: 5 }, () => setup({ maxBitrate: 59500 }));
  for (const viewer of viewers) {
    viewer.at(6000);
    viewer.controller.sample({ ...playing, bufferAhead: 14, stallBitrate: 11900 });
    assert.deepEqual(viewer.changes, []);
  }
  const slow = viewers[4];
  slow.at(7000); slow.controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 11900 });
  slow.at(12000); slow.controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 11900 });
  assert.deepEqual(slow.changes, [{ bitrate: 11900, reason: 'stall' }]);
  assert.ok(viewers.slice(0, 4).every(viewer => viewer.changes.length === 0));
});

test('actual stalls reduce the original rendition demand instead of stepping through unused request caps', () => {
  const { controller, changes, at } = setup({ maxBitrate: 127500, originalBitrate: 10000 });
  for (let seconds = 6; seconds <= 60; seconds += 2) {
    at(seconds * 1000);
    controller.sample({ ...playing, bufferAhead: 14, stallBitrate: 42500, advancing: true });
  }
  assert.deepEqual(changes, [], 'Healthy playback preserves original quality regardless of the fair-share hint.');
  at(61000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 42500, advancing: false });
  at(66000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 42500, advancing: false });
  assert.deepEqual(changes, [{ bitrate: 7500, reason: 'stall' }]);
});

test('measured capacity takes precedence over a fallback and retains its sustainable quality', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500 });
  for (let seconds = 3; seconds <= 9; seconds += 3) {
    at(seconds * 1000);
    controller.fragment({ bytes: 5250000, downloadMs: 3000, duration: 2, bufferAhead: 3 });
    controller.sample({ ...playing, stallBitrate: 1500 });
  }
  assert.deepEqual(changes, [{ bitrate: 11900, reason: 'bandwidth' }]);
});

test('fourteen Mbps supports recovery from eight to twelve Mbps without repeated quality changes', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, currentBitrate: 8000 });
  for (let seconds = 6; seconds <= 66; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 875000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  assert.deepEqual(changes, [{ bitrate: 12000, reason: 'recovery' }]);
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 12000 });
  for (let seconds = 68; seconds <= 200; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 875000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  assert.equal(changes.length, 1, 'A healthy sustainable cap must not oscillate.');
});

test('a restored upload can recover the full common ceiling in one change', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, currentBitrate: 1500 });
  for (let seconds = 6; seconds <= 66; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 4375000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  assert.deepEqual(changes, [{ bitrate: 59500, reason: 'recovery' }]);
});

test('a global playback hold does not count toward measured healthy recovery', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, currentBitrate: 8000 });
  for (let seconds = 6; seconds <= 100; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 875000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14, advancing: seconds < 30 });
  }
  assert.deepEqual(changes, []);
  for (let seconds = 102; seconds <= 162; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 875000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14, advancing: true });
  }
  assert.deepEqual(changes, [{ bitrate: 12000, reason: 'recovery' }]);
});

test('the original rendition can recover when its request cap exceeds the source bandwidth', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, originalBitrate: 31000 });
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 30000 });
  for (let seconds = 6; seconds <= 66; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 2187500, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  assert.deepEqual(changes, [{ bitrate: 59500, reason: 'recovery' }]);
});

test('a rejected original-demand probe backs off instead of retrying a failing ceiling every minute', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, originalBitrate: 31000 });
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 30000 });
  for (let seconds = 6; seconds <= 66; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 2187500, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 59500, originalBitrate: 31000 });
  at(86000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 30000 });
  at(91000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 30000 });
  assert.deepEqual(changes[1], { bitrate: 30000, reason: 'stall' });
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 30000 });
  for (let seconds = 100; seconds <= 380; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 2187500, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  assert.equal(changes.length, 2, 'The failed original-demand probe is blocked even with healthy lower-quality playback.');
});

test('a new original master replaces the prior demand and an unavailable master clears it', () => {
  for (const originalBitrate of [50000, undefined]) {
    const { controller, changes, at } = setup({ maxBitrate: 59500, originalBitrate: 10000 });
    controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 59500, originalBitrate });
    controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 30000 });
    for (let seconds = 6; seconds <= 66; seconds += 2) {
      at(seconds * 1000);
      controller.fragment({ bytes: 2187500, downloadMs: 500, duration: 2, bufferAhead: 14 });
      controller.sample({ ...playing, bufferAhead: 14 });
    }
    assert.deepEqual(changes, []);
  }
});

test('a conservative original peak permits a guarded full-quality probe after two healthy minutes', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, originalBitrate: 13200 });
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 8000 });
  for (let seconds = 6; seconds <= 126; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 625000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14, advancing: true });
    if (seconds < 126) assert.equal(changes.length, 0);
  }
  assert.deepEqual(changes, [{ bitrate: 59500, reason: 'recovery' }]);
});

test('a failed peak-bandwidth probe restores working quality and obeys the same five-minute backoff', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, originalBitrate: 13200 });
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 8000 });
  for (let seconds = 6; seconds <= 126; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 625000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14, advancing: true });
  }
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 59500, originalBitrate: 13200 });
  at(146000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 8000 });
  at(151000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 8000 });
  assert.deepEqual(changes, [{ bitrate: 59500, reason: 'recovery' }, { bitrate: 8000, reason: 'stall' }]);
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 8000 });
  for (let seconds = 158; seconds < 451; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 625000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14, advancing: true });
  }
  assert.equal(changes.length, 2);
  at(451000);
  controller.fragment({ bytes: 625000, downloadMs: 500, duration: 2, bufferAhead: 14 });
  controller.sample({ ...playing, bufferAhead: 14, advancing: true });
  assert.deepEqual(changes[2], { bitrate: 59500, reason: 'recovery' });
});

test('an original peak probe needs an original hint and uninterrupted actual healthy playback', () => {
  for (const originalBitrate of [undefined, 13200]) {
    const { controller, changes, at } = setup({ maxBitrate: 59500, originalBitrate });
    controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 8000 });
    for (let seconds = 6; seconds <= 240; seconds += 2) {
      at(seconds * 1000);
      controller.fragment({ bytes: 625000, downloadMs: 500, duration: 2, bufferAhead: 14 });
      controller.sample({ ...playing, bufferAhead: 14, advancing: originalBitrate === undefined || seconds !== 124 });
    }
    assert.deepEqual(changes, []);
  }
});

test('a fully occupied minimum-quality connection cannot repeatedly probe a much heavier original', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, originalBitrate: 20000 });
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 1500 });
  for (let seconds = 6; seconds <= 900; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 93750, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14, advancing: true });
  }
  assert.deepEqual(changes, []);
});

test('without a useful sample or hint a stall steps down without a fixed eight Mbps ceiling', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500 });
  at(6000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  at(11000); controller.sample({ ...playing, stalled: true, bufferAhead: 0 });
  assert.deepEqual(changes, [{ bitrate: 44625, reason: 'stall' }]);
});

test('native playback probes one step after a minute of actual progress even without exposed buffer ranges', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, currentBitrate: 8000, measuredTransfers: false });
  for (let seconds = 6; seconds <= 66; seconds += 2) {
    at(seconds * 1000);
    controller.sample({ ...playing, bufferAhead: 0, advancing: true });
    if (seconds < 66) assert.equal(changes.length, 0);
  }
  assert.deepEqual(changes, [{ bitrate: 12000, reason: 'recovery' }]);
});

test('native recovery requires uninterrupted actual progress and does not count a paused room', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, currentBitrate: 8000, measuredTransfers: false });
  for (let seconds = 6; seconds <= 30; seconds += 2) {
    at(seconds * 1000); controller.sample({ ...playing, bufferAhead: 0, advancing: true });
  }
  for (let seconds = 32; seconds <= 100; seconds += 2) {
    at(seconds * 1000); controller.sample({ ...playing, bufferAhead: 0, advancing: false });
  }
  assert.deepEqual(changes, []);
  for (let seconds = 102; seconds <= 160; seconds += 2) {
    at(seconds * 1000); controller.sample({ ...playing, bufferAhead: 0, advancing: true });
    assert.equal(changes.length, 0);
  }
  at(162000); controller.sample({ ...playing, bufferAhead: 0, advancing: true });
  assert.deepEqual(changes, [{ bitrate: 12000, reason: 'recovery' }]);
});

test('a failed native quality probe restores its prior working cap and waits five minutes before retrying', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, currentBitrate: 8000, measuredTransfers: false });
  at(6000); controller.sample({ ...playing, bufferAhead: 0, advancing: true });
  at(66000); controller.sample({ ...playing, bufferAhead: 0, advancing: true });
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 12000, measuredTransfers: false });
  at(86000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 11900, advancing: false });
  at(91000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 11900, advancing: false });
  assert.deepEqual(changes, [{ bitrate: 12000, reason: 'recovery' }, { bitrate: 8000, reason: 'stall' }]);
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 8000, measuredTransfers: false });
  for (let seconds = 100; seconds < 391; seconds += 5) {
    at(seconds * 1000); controller.sample({ ...playing, bufferAhead: 0, advancing: true });
  }
  assert.equal(changes.length, 2);
  at(391000); controller.sample({ ...playing, bufferAhead: 0, advancing: true });
  assert.deepEqual(changes[2], { bitrate: 12000, reason: 'recovery' });
});

test('a sub-minimum fair-share hint clamps to the supported minimum instead of being ignored', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500 });
  at(6000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 1360 });
  at(11000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 1360 });
  assert.deepEqual(changes, [{ bitrate: 1500, reason: 'stall' }]);
});

test('a failed measured upgrade restores its working cap and blocks every upgrade route for five minutes', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, currentBitrate: 8000 });
  for (let seconds = 6; seconds <= 66; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 875000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 12000 });
  at(86000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 11900 });
  at(91000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 11900 });
  assert.deepEqual(changes, [{ bitrate: 12000, reason: 'recovery' }, { bitrate: 8000, reason: 'stall' }]);
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 8000 });
  for (let seconds = 100; seconds < 391; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 4375000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  assert.equal(changes.length, 2, 'Even a full-capacity estimate cannot repeatedly retry a failed upgrade during backoff.');
  at(391000);
  controller.fragment({ bytes: 4375000, downloadMs: 500, duration: 2, bufferAhead: 14 });
  controller.sample({ ...playing, bufferAhead: 14 });
  assert.deepEqual(changes[2], { bitrate: 59500, reason: 'recovery' });
});

test('a proven successful upgrade is not rolled back to an obsolete cap after a later unrelated outage', () => {
  const { controller, changes, at } = setup({ maxBitrate: 59500, currentBitrate: 8000 });
  for (let seconds = 6; seconds <= 66; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 4375000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  controller.configure({ remote: true, maxBitrate: 59500, currentBitrate: 59500 });
  for (let seconds = 72; seconds <= 132; seconds += 2) {
    at(seconds * 1000);
    controller.fragment({ bytes: 4375000, downloadMs: 500, duration: 2, bufferAhead: 14 });
    controller.sample({ ...playing, bufferAhead: 14 });
  }
  at(160000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 30000 });
  at(165000); controller.sample({ ...playing, stalled: true, bufferAhead: 0, stallBitrate: 30000 });
  assert.deepEqual(changes, [{ bitrate: 59500, reason: 'recovery' }, { bitrate: 30000, reason: 'stall' }]);
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
