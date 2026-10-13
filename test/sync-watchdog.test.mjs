import test from 'node:test';
import assert from 'node:assert/strict';
import { syncWatchdog } from '../src/sync-watchdog.ts';

test('two failed hard corrections recover once without counting seek jumps as playback', () => {
  const watch = syncWatchdog();
  watch.corrected(0, 10);
  assert.equal(watch.sample(1999, 10, 12, true, false), false);
  assert.equal(watch.sample(2000, 10, 12, true, false), false);
  watch.corrected(2000, 12);
  assert.equal(watch.sample(4000, 12, 14, true, false), true);
});

test('advancing playback within one second of target verifies a correction', () => {
  const watch = syncWatchdog();
  watch.corrected(0, 10);
  assert.equal(watch.sample(2000, 12, 12.3, true, false), false);
  watch.corrected(3000, 15);
  assert.equal(watch.sample(5000, 15, 17, true, false), false, 'A later isolated failure does not inherit a successful correction.');
  assert.equal(watch.sample(7000, 17, 17.2, true, false), false);
  watch.corrected(8000, 18);
  assert.equal(watch.sample(10000, 18, 20, true, false), false, 'Healthy ordinary progress clears older failure history.');
});

test('ignored seek assignments and advancing but persistently wrong playback both fail verification', () => {
  const watch = syncWatchdog();
  watch.corrected(0, 3);
  assert.equal(watch.sample(2000, 5, 9, true, false), false);
  watch.corrected(2000, 5);
  assert.equal(watch.sample(4000, 7, 11, true, false), true);
});

test('legitimate exclusions clear failures and an automatic seek must finish before verification', () => {
  const watch = syncWatchdog();
  watch.corrected(0, 10);
  assert.equal(watch.sample(2000, 10, 12, true, true), false);
  assert.equal(watch.sample(2100, 10, 12.1, true, false), false);
  assert.equal(watch.sample(2200, 10, 12.2, false, false), false);
  watch.corrected(3000, 13);
  assert.equal(watch.sample(5000, 13, 15, true, false), false);
});

test('the 30-second recovery cooldown survives source-history resets', () => {
  const watch = syncWatchdog();
  watch.corrected(0, 10); watch.sample(2000, 10, 12, true, false);
  watch.corrected(2000, 12);
  assert.equal(watch.sample(4000, 12, 14, true, false), true);
  watch.reset();
  watch.corrected(5000, 15); watch.sample(7000, 15, 17, true, false);
  watch.corrected(7000, 17);
  assert.equal(watch.sample(9000, 17, 19, true, false), false);
  watch.reset();
  watch.corrected(30000, 40); watch.sample(32000, 40, 42, true, false);
  watch.corrected(32000, 42);
  assert.equal(watch.sample(34000, 42, 44, true, false), true);
});
