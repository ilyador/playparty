import test from 'node:test';
import assert from 'node:assert/strict';
import { seekWatchdog } from '../src/seek-watchdog.ts';

test('normal seeks do not interrupt the room and completed seeks clear the timer', () => {
  const watch = seekWatchdog();
  assert.deepEqual(watch.sample(0, true, true), { stalled: false, reload: false });
  assert.deepEqual(watch.sample(900, true, true), { stalled: false, reload: false });
  assert.deepEqual(watch.sample(1000, false, true), { stalled: false, reload: false });
  assert.deepEqual(watch.sample(10000, true, true), { stalled: false, reload: false });
});

test('a stuck seek holds the timeline before replacing a source with available data', () => {
  const watch = seekWatchdog();
  watch.sample(1000, true, true);
  assert.deepEqual(watch.sample(2500, true, true), { stalled: true, reload: false });
  assert.deepEqual(watch.sample(9000, true, true), { stalled: true, reload: true });
  watch.reset();
  assert.deepEqual(watch.sample(9001, true, true), { stalled: false, reload: false });
});

test('a slow network seek waits for data rather than repeatedly replacing its stream', () => {
  const watch = seekWatchdog();
  watch.sample(0, true, false);
  assert.deepEqual(watch.sample(60000, true, false), { stalled: true, reload: false });
  assert.deepEqual(watch.sample(60001, true, true), { stalled: true, reload: true });
});
