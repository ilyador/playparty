import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function player({ readOnlyVolume = false } = {}) {
  let time = 0, id = 0, volume = 1;
  const frames = new Map(), timers = new Map();
  const diagnostics = [];
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL('../src/movie-audio.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, performance: { now: () => time },
    requestAnimationFrame: fn => { const next = ++id; frames.set(next, fn); return next; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, delay) => { const next = ++id; timers.set(next, { fn, at: time + delay }); return next; }, clearTimeout: id => timers.delete(id) });
  const video = { muted: false, get volume() { return volume; }, set volume(value) { if (!readOnlyVolume) volume = value; } };
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

test('read-only iOS volume falls back to movie-only mute and preserves the viewer’s mute choice', () => {
  const { video, controller, advance } = player({ readOnlyVolume: true });
  controller.setSpeech(true); advance(320); assert.equal(video.muted, true); assert.equal(video.volume, 1);
  controller.setSpeech(false); advance(1300); assert.equal(video.muted, false);
  controller.setSpeech(true); advance(320); controller.setMuted(true);
  controller.setSpeech(false); advance(1300); assert.equal(video.muted, true);
  controller.dispose(); assert.equal(video.muted, true);
});

test('brief speech detections never interrupt a movie when iOS volume is read-only', () => {
  const { video, controller, advance, diagnostics } = player({ readOnlyVolume: true });
  for (let i = 0; i < 6; i++) {
    controller.setSpeech(true); advance(160);
    controller.setSpeech(false); advance(900);
    assert.equal(video.muted, false);
  }
  advance(2000);
  assert.equal(diagnostics.some(sample => sample.movieMuted), false);
  assert.equal(diagnostics.some(sample => sample.ducked), false);
});

test('qualified iOS speech stays muted through short pauses and restores once after sustained silence', () => {
  const { video, controller, advance, diagnostics } = player({ readOnlyVolume: true });
  controller.setSpeech(true); advance(160); controller.setSpeech(true); advance(160);
  assert.equal(video.muted, true, 'Repeated true signals must not postpone qualification.');
  for (let i = 0; i < 4; i++) {
    controller.setSpeech(false); advance(900);
    assert.equal(video.muted, true, 'Short pauses must not fragment movie audio.');
    controller.setSpeech(true); advance(160);
  }
  controller.setSpeech(false); advance(900); controller.setSpeech(false); advance(400);
  assert.equal(video.muted, false, 'Repeated false signals must not postpone restoration.');
  const muteTransitions = diagnostics.filter((sample, i) => i === 0 || sample.movieMuted !== diagnostics[i - 1].movieMuted).map(sample => sample.movieMuted);
  assert.deepEqual(muteTransitions, [false, true, false]);
  assert.ok(diagnostics.every(sample => Object.keys(sample).sort().join(',') === 'ducked,event,movieMuted,speech,volumeWritable'));
});

test('disposal cancels pending iOS speech qualification and preserves personal mute through silence', () => {
  const first = player({ readOnlyVolume: true });
  first.controller.setSpeech(true); first.advance(160); first.controller.dispose(); first.advance(2000);
  assert.equal(first.video.muted, false);
  const count = first.diagnostics.length;
  first.controller.setSpeech(true); first.controller.setMuted(true); first.advance(2000);
  assert.equal(first.video.muted, false); assert.equal(first.diagnostics.length, count);

  const second = player({ readOnlyVolume: true });
  second.controller.setMuted(true); second.controller.setSpeech(true); second.advance(320);
  second.controller.setSpeech(false); second.advance(160); second.controller.dispose(); second.advance(2000);
  assert.equal(second.video.muted, true);
});
