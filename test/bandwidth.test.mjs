import test from 'node:test';
import assert from 'node:assert/strict';
import { MovieBudget } from '../server/bandwidth.mjs';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const budget = new MovieBudget(8), deliveries = [], readers = [];
  t.after(() => { for (const reader of readers) reader.destroy(); });
  function reader(name) {
    const stream = budget.limiter();
    stream.on('data', () => deliveries.push({ name, time: Date.now() }));
    stream.on('error', () => {});
    readers.push(stream);
    return stream;
  }
  return { reader, deliveries, tick: milliseconds => t.mock.timers.tick(milliseconds) };
}

test('parallel movie readers share one paced budget and each queued reader gets a turn', t => {
  const { reader, deliveries, tick } = fixture(t);
  const chunk = Buffer.alloc(100000); // 100 ms at 8 Mbps.
  const first = reader('first');
  first.write(chunk);
  first.end(chunk);
  reader('second').end(chunk);
  reader('third').end(chunk);
  tick(0);
  assert.deepEqual(deliveries, [{ name: 'first', time: 0 }]);
  tick(99);
  assert.equal(deliveries.length, 1);
  tick(1);
  tick(100);
  tick(100);
  assert.deepEqual(deliveries, [
    { name: 'first', time: 0 }, { name: 'second', time: 100 },
    { name: 'third', time: 200 }, { name: 'first', time: 300 },
  ]);
});

test('cancelled seeks cannot reserve bandwidth ahead of the next healthy reader', t => {
  const { reader, deliveries, tick } = fixture(t);
  for (let i = 0; i < 100; i++) {
    const abandoned = reader(`abandoned-${i}`);
    abandoned.end(Buffer.alloc(65536));
    abandoned.destroy();
  }
  reader('healthy').end(Buffer.alloc(65536));
  tick(0);
  assert.deepEqual(deliveries, [{ name: 'healthy', time: 0 }]);
  tick(10000);
  assert.equal(deliveries.length, 1, 'Destroyed readers cannot deliver their queued chunks later.');
});

test('cancelling queued readers preserves only bandwidth already delivered to other viewers', t => {
  const { reader, deliveries, tick } = fixture(t);
  const chunk = Buffer.alloc(100000);
  reader('already delivered').end(chunk);
  tick(0);
  const failed = reader('failed'); failed.end(chunk);
  const left = reader('left'); left.end(chunk);
  reader('staying').end(chunk);
  left.destroy();
  failed.destroy(new Error('Simulated aborted movie response.'));
  tick(99);
  assert.deepEqual(deliveries, [{ name: 'already delivered', time: 0 }]);
  tick(1);
  assert.deepEqual(deliveries, [{ name: 'already delivered', time: 0 }, { name: 'staying', time: 100 }]);
  tick(1000);
  assert.equal(deliveries.length, 2);
  reader('later').end(chunk);
  tick(0);
  assert.deepEqual(deliveries.at(-1), { name: 'later', time: 1100 }, 'An idle budget is immediately reusable.');
});

test('removing the final waiting reader cancels its wakeup and leaves the budget reusable', t => {
  const { reader, deliveries, tick } = fixture(t);
  const chunk = Buffer.alloc(100000);
  reader('first').end(chunk);
  tick(0);
  const abandoned = reader('abandoned'); abandoned.end(chunk);
  abandoned.destroy();
  tick(1000);
  assert.deepEqual(deliveries, [{ name: 'first', time: 0 }]);
  reader('next').end(chunk);
  tick(0);
  assert.deepEqual(deliveries.at(-1), { name: 'next', time: 1000 });
});
