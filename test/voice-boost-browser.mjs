// iPhone call-voice boost through real WebKit Web Audio and MediaStream audio.
// Linux WebKit never locks media volume, so ':volume-locked' is reported the
// way iPhone Safari reports it. This proves levels and limiting, not iOS's
// echo-cancelled output routing; that still needs a physical iPhone.
// The page stays silent: test outputs are muted and only their streams are measured.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { webkit } from 'playwright';

const code = ts.transpileModule(fs.readFileSync(new URL('../src/call-audio.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><body style="margin:0;height:100vh"></body>');
  await page.evaluate(source => {
    const matches = Element.prototype.matches;
    Element.prototype.matches = function (selector) {
      return selector === ':volume-locked' ? this instanceof HTMLMediaElement : matches.call(this, selector);
    };
    const exports = {};
    new Function('exports', source)(exports);
    const voice = new AudioContext(), meter = new AudioContext();
    const tone = voice.createOscillator(), level = voice.createGain(), stream = voice.createMediaStreamDestination();
    level.gain.value = 0; tone.connect(level).connect(stream); tone.start();
    const mediaStreamTrack = stream.stream.getAudioTracks()[0];
    // The parts of LiveKit's RemoteAudioTrack that remoteCallAudio uses.
    const remote = { sid: 'voice', kind: 'audio', source: 'microphone', mediaStreamTrack, attachedElements: [],
      attach() {
        const element = document.createElement('audio');
        element.srcObject = new MediaStream([mediaStreamTrack]); element.play().catch(() => {});
        this.attachedElements.push(element); return element;
      },
      detach(element) { this.attachedElements.splice(this.attachedElements.indexOf(element), 1); },
      on() {}, off() {},
    };
    document.body.addEventListener('click', () => { voice.resume(); meter.resume(); });
    const samples = [], audio = exports.remoteCallAudio(document.body, sample => samples.push(sample));
    window.test = { meter, level, samples, audio, direct: audio.attach(remote, 'person') };
  }, code);
  await page.mouse.click(20, 20);
  await page.waitForFunction(() => window.test.samples.at(-1)?.callAudioBoosted === true, null, { timeout: 5000 });
  const result = await page.evaluate(async () => {
    const { meter, level, direct } = window.test;
    const output = [...document.querySelectorAll('audio')].find(element => element !== direct);
    output.muted = true;
    const analyser = stream => {
      const node = meter.createAnalyser(); node.fftSize = 2048;
      meter.createMediaStreamSource(stream).connect(node); return node;
    };
    const boosted = analyser(output.srcObject), original = analyser(direct.srcObject);
    const measure = async gain => {
      level.gain.value = gain;
      await new Promise(resolve => setTimeout(resolve, 600));
      const a = new Float32Array(2048), b = new Float32Array(2048);
      let peak = 0, boostedEnergy = 0, originalEnergy = 0;
      for (let read = 0; read < 20; read++) {
        boosted.getFloatTimeDomainData(a); original.getFloatTimeDomainData(b);
        for (let i = 0; i < a.length; i++) { peak = Math.max(peak, Math.abs(a[i])); boostedEnergy += a[i] ** 2; originalEnergy += b[i] ** 2; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { peak, decibels: 10 * Math.log10(boostedEnergy / originalEnergy) };
    };
    return { speech: await measure(0.05), loud: await measure(0.9), directMuted: direct.muted };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.directMuted, true, 'The direct copy must be muted while the boosted mix plays.');
  assert.ok(result.speech.decibels > 8 && result.speech.decibels < 13, `Ordinary speech should rise about 10 dB, got ${result.speech.decibels.toFixed(1)} dB.`);
  assert.ok(result.loud.peak < 1, `Loud speech must stay below full scale, peaked at ${result.loud.peak.toFixed(3)}.`);
  await page.evaluate(() => window.test.audio.dispose());
} finally {
  await browser.close();
}
