import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRate } from '../src/sync-rate.ts';

test('ordinary arrival jitter leaves movie audio at its natural speed', () => {
  let rate = 1;
  for (const drift of [0.11, 0.13, 0.1, 0.15, -0.13, -0.18, 0.3]) {
    rate = syncRate(rate, drift);
    assert.equal(rate, 1);
  }
});

test('correction stays stable through jitter and stops when viewers are close', () => {
  assert.equal(syncRate(1, 0.5), 1.03);
  for (const drift of [0.31, 0.14, 0.12, 0.16, 0.1]) assert.equal(syncRate(1.03, drift), 1.03);
  assert.equal(syncRate(1.03, 0.04), 1);
  assert.equal(syncRate(1, -0.5), 0.97);
  assert.equal(syncRate(0.97, -0.1), 0.97);
  assert.equal(syncRate(0.97, -0.02), 1);
  assert.equal(syncRate(1.03, -0.2), 1);
  assert.equal(syncRate(0.97, NaN), 1);
});
