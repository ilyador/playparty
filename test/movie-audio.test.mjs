import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function player({ readOnlyVolume = false } = {}) {
  let time = 0, id = 0, volume = 1;
  const frames = new Map(), timers = new Map();
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL('../src/movie-audio.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, performance: { now: () => time },
    requestAnimationFrame: fn => { const next = ++id; frames.set(next, fn); return next; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, delay) => { const next = ++id; timers.set(next, { fn, at: time + delay }); return next; }, clearTimeout: id => timers.delete(id) });
  const video = { muted: false, get volume() { return volume; }, set volume(value) { if (!readOnlyVolume) volume = value; } };
  const controller = exports.movieAudio(video);
  const advance = ms => { const end = time + ms; while (time < end) { time = Math.min(end, time + 16); for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); } const pending = [...frames]; frames.clear(); for (const [, fn] of pending) fn(time); } };
  return { video, controller, advance };
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
  controller.setSpeech(true); assert.equal(video.muted, true); assert.equal(video.volume, 1);
  controller.setSpeech(false); advance(900); assert.equal(video.muted, false);
  controller.setSpeech(true); controller.setMuted(true);
  controller.setSpeech(false); advance(900); assert.equal(video.muted, true);
  controller.dispose(); assert.equal(video.muted, true);
});
