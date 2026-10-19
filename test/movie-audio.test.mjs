import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// 'writable' is desktop Chrome/Firefox, where ':volume-locked' is not a valid selector.
// 'locked' is iPhone WebKit: a write reads back until Safari's queued revert runs.
// 'ignored' is any browser that drops volume writes outright.
function player({ volume: model = 'writable' } = {}) {
  let time = 0, id = 0, volume = 1;
  const frames = new Map(), timers = new Map();
  const diagnostics = [];
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL('../src/movie-audio.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, performance: { now: () => time },
    requestAnimationFrame: fn => { const next = ++id; frames.set(next, fn); return next; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, delay) => { const next = ++id; timers.set(next, { fn, at: time + delay }); return next; }, clearTimeout: id => timers.delete(id) });
  const video = { muted: false,
    matches(selector) {
      if (model === 'locked') return selector === ':volume-locked';
      throw new SyntaxError(`'${selector}' is not a valid selector.`);
    },
    get volume() { return volume; },
    set volume(value) {
      if (model === 'writable') volume = value;
      else if (model === 'locked') { volume = value; timers.set(++id, { fn: () => { volume = 1; }, at: time }); }
    } };
  const controller = exports.movieAudio(video, sample => diagnostics.push(structuredClone(sample)));
  const advance = ms => { const end = time + ms; while (time < end) { time = Math.min(end, time + 16); for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); } const pending = [...frames]; frames.clear(); for (const [, fn] of pending) fn(time); } };
  return { video, controller, advance, diagnostics };
}

test('movie fades for speech, holds through short pauses and restores without changing personal mute', () => {
  const { video, controller, advance } = player();
  controller.setSpeech(true); advance(64);
  assert.ok(video.volume > 0.3 && video.volume < 1);
  advance(96); assert.ok(Math.abs(video.volume - 0.3) < 1e-8);
  controller.setSpeech(false); advance(400); assert.ok(Math.abs(video.volume - 0.3) < 1e-8);
  controller.setSpeech(true); advance(500); assert.ok(Math.abs(video.volume - 0.3) < 1e-8);
  controller.setMuted(true);
  controller.setSpeech(false); advance(1400);
  assert.equal(video.volume, 1); assert.equal(video.muted, true);
  controller.setMuted(false); assert.equal(video.muted, false);
  controller.setSpeech(true); advance(160); controller.dispose(); advance(2000);
  assert.equal(video.volume, 1); assert.equal(video.muted, false);
});

test('fixed movie volume, including iPhone’s read-back writes, is reported and never cut by speech', () => {
  for (const volume of ['locked', 'ignored']) {
    const { video, controller, advance, diagnostics } = player({ volume });
    controller.setSpeech(true); advance(2000);
    assert.equal(video.muted, false, `${volume}: sustained speech must not cut the movie; call audio raises voices instead.`);
    controller.setSpeech(false); advance(1500); controller.setSpeech(true); advance(500);
    assert.equal(video.muted, false);
    assert.ok(diagnostics.every(sample => sample.volumeWritable === false), `${volume}: diagnostics must report fixed movie volume.`);
    assert.equal(diagnostics.some(sample => sample.ducked || sample.movieMuted), false);
    assert.ok(diagnostics.every(sample => Object.keys(sample).sort().join(',') === 'ducked,event,movieMuted,speech,volumeWritable'));
  }
});

test('personal movie mute still works when movie volume is fixed', () => {
  const { video, controller, advance, diagnostics } = player({ volume: 'locked' });
  controller.setMuted(true); assert.equal(video.muted, true);
  controller.setSpeech(true); advance(2000); controller.setSpeech(false); advance(1500);
  assert.equal(video.muted, true, 'Speech must not change the viewer’s mute choice.');
  controller.setMuted(false); assert.equal(video.muted, false);
  controller.setMuted(true); controller.dispose(); advance(2000);
  assert.equal(video.muted, true);
  const count = diagnostics.length;
  controller.setMuted(false); controller.setSpeech(true); advance(500);
  assert.equal(video.muted, true); assert.equal(diagnostics.length, count, 'A disposed controller must stay inert.');
});
