// Real Chrome lifecycle suspension and owner-tab replacement against isolated
// Plex/LiveKit sessions. No playback progress is written to the Plex library.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { RoomServiceClient } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const longSleep = process.env.TEST_LONG_SLEEP === '1';
const testPort = longSleep ? 5181 : 5179;
const origin = `http://localhost:${testPort}`;
const roomName = `playparty-lifecycle-test-${randomUUID()}`;
const ownerCookie = randomUUID(), errors = [], failures = [];
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const call = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const { server, party, close } = createApp({ plex, authenticateOwner: header => cookies(header).test_owner === ownerCookie,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', origin, roomName, recordProgress: false,
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined });
let browser, guestSession, chrome, chromeExit, chromeError, profile;
const instrument = () => {
  if (!navigator.mediaDevices?.getUserMedia) return;
  const NativeSocket = WebSocket, getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.testSockets = []; window.testCaptures = []; window.testTracks = []; window.testLifecycle = [];
  window.testStates = []; window.testPlays = []; window.testPlaying = []; window.testLastState = null; window.testOffset = 0; window.testTasks = 0;
  setInterval(() => window.testTasks++, 250);
  const nativeFetch = fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (new URL(response.url).pathname === '/api/playback' && response.ok) window.testOffset = Number((await response.clone().json()).offset) || 0;
    return response;
  };
  navigator.mediaDevices.getUserMedia = async constraints => {
    window.testCaptures.push(constraints);
    const stream = await getMedia(constraints); window.testTracks.push(...stream.getTracks()); return stream;
  };
  window.WebSocket = class extends NativeSocket {
    constructor(...args) { super(...args); window.testSockets.push(this); }
    get onmessage() { return this.testHandler; }
    set onmessage(handler) {
      this.testHandler = handler;
      super.onmessage = event => {
        if (typeof event.data === 'string') {
          try { const state = JSON.parse(event.data); if (state.type === 'state') { window.testLastState = state; window.testStates.push({ ...state, receivedAt: Date.now() }); } } catch {}
        }
        return handler?.call(this, event);
      };
    }
  };
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (this.classList.contains('movie-video')) window.testPlays.push({ at: Date.now(), state: window.testLastState, position: this.currentTime });
    return nativePlay.apply(this, args);
  };
  document.addEventListener('playing', event => {
    const v = event.target;
    if (v instanceof HTMLVideoElement && v.classList.contains('movie-video')) window.testPlaying.push({ at: Date.now(), state: window.testLastState, paused: v.paused, position: v.currentTime });
  }, true);
  for (const type of ['freeze', 'resume', 'visibilitychange']) document.addEventListener(type, () => {
    const v = document.querySelector('.movie-video');
    window.testLifecycle.push({ type, at: Date.now(), hidden: document.hidden, paused: v?.paused, position: v?.currentTime, tasks: window.testTasks });
  });
};
const playing = () => { const v = document.querySelector('.movie-video'); return v && !v.paused && v.readyState >= 3 && v.currentTime > 2; };
const join = async (page, name, host = false) => {
  await page.bringToFront();
  await page.locator('#name').fill(name);
  if (host) await page.getByRole('switch', { name: 'I am the host' }).check();
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.waitForFunction(() => window.testTracks.filter(track => track.readyState === 'live').length === 2, undefined, { timeout: 30000 });
};
const run = async (label, task) => {
  try { await task(); console.log(`${label}: passed.`); }
  catch (error) { failures.push({ label, error: error.message }); console.error(`${label}: ${error.message}`); }
};
try {
  await call.createRoom({ name: roomName });
  await new Promise(resolve => server.listen(testPort, '127.0.0.1', resolve));
  const library = (await plex.library()).filter(item => item.type === 'movie');
  assert.ok(library.length >= 2, 'Lifecycle movie-change testing needs at least two movies.');
  const first = library.find(item => item.title === process.env.TEST_MOVIE) || library[0];
  const second = library.find(item => item.id !== first.id);
  const movie = plex.simplify(await plex.metadata(first.id));
  // Playwright's ordinary launch forces every page visible, defeating actual
  // freeze. Use a fresh test profile and attach without those focus overrides.
  profile = await mkdtemp(path.join(os.tmpdir(), 'playparty-lifecycle-'));
  chrome = spawn(process.env.TEST_CHROME || '/usr/bin/google-chrome', ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  chromeExit = new Promise(resolve => { chrome.once('exit', resolve); chrome.once('error', error => { chromeError = error; resolve(); }); });
  let port;
  for (let attempt = 0; attempt < 100 && !port && !chromeError; attempt++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { await delay(100); }
  }
  assert.ok(port, chromeError ? `The isolated Chrome could not start (${chromeError.code}).` : 'The isolated Chrome must expose its own debugging endpoint.');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  const ownerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guestContext = browser.contexts()[0];
  await guestContext.grantPermissions(['camera', 'microphone']);
  for (const context of [ownerContext, guestContext]) await context.addInitScript(instrument);
  await ownerContext.addCookies([{ name: 'test_owner', value: ownerCookie, url: origin }]);
  const owner = await ownerContext.newPage(), guest = guestContext.pages()[0];
  const placeholder = await guestContext.newPage();
  await placeholder.goto('about:blank');
  for (const page of [owner, guest]) page.on('pageerror', error => errors.push(error.message));
  const post = (action, body = {}, page = owner) => page.evaluate(async ({ action, body }) => {
    const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
  }, { action, body });
  await owner.goto(origin); await join(owner, 'Lifecycle Host', true);
  await guest.goto(origin); await join(guest, 'Lifecycle Guest');
  await post('select', { id: first.id });
  await Promise.all([owner, guest].map(page => page.waitForFunction(playing, undefined, { timeout: 60000 })));
  const start = Math.min(600, Math.max(10, movie.duration / 3));
  await post('control', { action: 'seek', position: start });
  await Promise.all([owner, guest].map(page => page.waitForFunction(position => { const v = document.querySelector('.movie-video'); return v && !v.paused && v.currentTime >= position; }, start, { timeout: 60000 })));
  guestSession = await guestContext.newCDPSession(guest);
  await guest.bringToFront();

  if (!longSleep) await run('Fifteen-second real page freeze with host pause', async () => {
    const before = await guest.evaluate(() => ({ position: document.querySelector('.movie-video').currentTime, plays: window.testPlays.length, tasks: window.testTasks }));
    await placeholder.bringToFront();
    await guestSession.send('Page.setWebLifecycleState', { state: 'frozen' });
    await post('control', { action: 'pause' });
    const pausedAt = party.currentPosition();
    await delay(15000);
    await guestSession.send('Page.setWebLifecycleState', { state: 'active' });
    await guest.bringToFront();
    await guest.waitForFunction(() => document.querySelector('.movie-video')?.paused, undefined, { timeout: 3000 });
    const after = await guest.evaluate(plays => ({ position: document.querySelector('.movie-video').currentTime,
      lifecycle: window.testLifecycle, plays: window.testPlays.slice(plays), captures: window.testCaptures.length, tasks: window.testTasks, hidden: document.hidden }), before.plays);
    assert.ok(after.lifecycle.some(event => event.type === 'freeze') && after.lifecycle.some(event => event.type === 'resume'), 'Chrome must actually dispatch both lifecycle suspension events.');
    assert.ok(after.tasks - before.tasks < 15, 'Fifteen seconds frozen must suspend the real JavaScript timer rather than only issue a successful CDP command.');
    assert.equal(after.hidden, false, 'Returning must make the real document visible again.');
    assert.equal(party.currentPosition(), pausedAt, 'The intentionally paused shared clock cannot advance.');
    assert.ok(Math.abs(after.position - pausedAt) < 1, `Resume after a host pause must return to the shared position: ${JSON.stringify(after)}`);
    assert.ok(after.plays.every(play => play.state?.paused), 'A resumed frozen client cannot request playback using queued old playing state.');
    assert.equal(after.captures, 1, 'Lifecycle resume cannot reacquire call devices.');
  });

  if (!longSleep) await run('Frozen guest follows movie change and paused seek', async () => {
    await placeholder.bringToFront();
    await guestSession.send('Page.setWebLifecycleState', { state: 'frozen' });
    await post('select', { id: second.id });
    await post('control', { action: 'pause' });
    await post('control', { action: 'seek', position: 90 });
    const version = party.mediaVersion;
    await delay(15000);
    await guestSession.send('Page.setWebLifecycleState', { state: 'active' });
    await guest.bringToFront();
    await guest.waitForFunction(({ version, id }) => {
      const v = document.querySelector('.movie-video');
      return !document.hidden && v?.paused && v.readyState >= 3 && window.testLastState?.mediaVersion === version && window.testLastState.movie?.id === id && Math.abs(v.currentTime + window.testOffset - 90) < 1;
    }, { version, id: second.id }, { timeout: 60000 });
    await delay(2200);
    const result = await guest.evaluate(() => ({ paused: document.querySelector('.movie-video').paused, current: document.querySelector('.movie-video').currentTime + window.testOffset,
      liveSockets: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length,
      captures: window.testCaptures.length, outputs: document.querySelectorAll('audio.call-audio').length }));
    assert.deepEqual(result, { paused: true, current: result.current, liveSockets: 1, captures: 1, outputs: 1 });
    assert.ok(Math.abs(result.current - 90) < 1);
    assert.equal(party.currentPosition(), 90);
  });

  if (!longSleep) await run('Repeated foreground transitions preserve one call and state socket', async () => {
    assert.equal(await guest.evaluate(() => document.visibilityState), 'visible');
    const beforeSockets = await guest.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length);
    for (let index = 0; index < 4; index++) {
      await guest.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await delay(200);
    }
    await delay(2200);
    const result = await guest.evaluate(() => ({ liveSockets: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length,
      captures: window.testCaptures.length, tracks: window.testTracks.filter(track => track.readyState === 'live').length,
      outputs: document.querySelectorAll('audio.call-audio').length, paused: document.querySelector('.movie-video').paused }));
    assert.deepEqual(result, { liveSockets: 1, captures: 1, tracks: 2, outputs: 1, paused: true });
    assert.ok(await guest.evaluate(count => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length >= count + 4, beforeSockets), 'Every foreground transition must actually exercise replacement of the state connection.');
    await post('control', { action: 'play' });
    await Promise.all([owner, guest].map(page => page.waitForFunction(playing, undefined, { timeout: 60000 })));
    await delay(1500);
    for (let sample = 0; sample < 10; sample++) {
      const state = party.snapshot();
      const readings = await Promise.all([owner, guest].map(page => page.evaluate(() => {
        const v = document.querySelector('.movie-video'); return { time: v.currentTime + window.testOffset, at: Date.now(), paused: v.paused };
      })));
      assert.ok(!state.paused && !state.waiting, 'Resume after lifecycle churn must retain a playing shared timeline.');
      for (const reading of readings) {
        assert.equal(reading.paused, false);
        assert.ok(Math.abs(reading.time - (state.position + Math.max(0, reading.at - state.updatedAt) / 1000)) < 1, 'Resumed clients must remain within one second of the shared clock for repeated samples.');
      }
      await delay(500);
    }
  });

  if (longSleep) {
    const clockKeys = ['mediaVersion', 'readinessVersion', 'updatedAt', 'position', 'paused', 'waiting'];
    const stableAfterWake = async (label, expectedCaptures) => {
      let healthySince = 0, samples = 0, maxClockDrift = 0, maxPairDrift = 0;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && (!healthySince || Date.now() - healthySince < 10000)) {
        const state = party.snapshot();
        const readings = await Promise.all([owner, guest].map(page => page.evaluate(() => {
          const v = document.querySelector('.movie-video');
          return { time: v.currentTime + window.testOffset, at: Date.now(), paused: v.paused,
            state: window.testLastState, ready: v.readyState,
            sockets: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length,
            captures: window.testCaptures.length, tracks: window.testTracks.filter(track => track.readyState === 'live').length,
            outputs: document.querySelectorAll('audio.call-audio').length };
        })));
        const after = party.snapshot();
        const unchanged = clockKeys.every(key => state[key] === after[key]);
        const healthy = unchanged && !state.paused && !state.waiting && readings.every((reading, index) =>
          !reading.paused && reading.ready >= 3 && reading.sockets === 1 && reading.outputs === 1 && reading.tracks === 2 &&
          reading.captures === (index === 0 ? 1 : expectedCaptures) && reading.state && clockKeys.every(key => reading.state[key] === state[key]) &&
          Math.abs(reading.time - (state.position + Math.max(0, reading.at - state.updatedAt) / 1000)) < 1);
        if (healthy) {
          healthySince ||= Date.now(); samples++;
          for (const reading of readings) maxClockDrift = Math.max(maxClockDrift, Math.abs(reading.time - (state.position + Math.max(0, reading.at - state.updatedAt) / 1000)));
          maxPairDrift = Math.max(maxPairDrift, Math.abs(readings[0].time - readings[1].time - (readings[0].at - readings[1].at) / 1000));
        } else healthySince = 0;
        await delay(500);
      }
      assert.ok(healthySince && Date.now() - healthySince >= 10000, `${label} must sustain ten seconds of actual playing frames against an immutable shared checkpoint.`);
      assert.ok(samples >= 20, 'Recovery must include repeated stable samples rather than a single lucky reading.');
      console.log(`${label}: ${samples} healthy readings; shared drift ${maxClockDrift.toFixed(3)}s; pair drift ${maxPairDrift.toFixed(3)}s.`);
    };
    const guestId = [...party.members.keys()].find(id => id !== 'owner');
    assert.ok(guestId);

    await run('Sixty-five-second genuine freeze retains muted choice and current paused seek', async () => {
      await guest.getByRole('button', { name: 'Mute microphone', exact: true }).click();
      await guest.getByRole('button', { name: 'Turn on microphone', exact: true }).waitFor();
      await guest.waitForFunction(() => window.testTracks.some(track => track.kind === 'audio' && track.readyState === 'live' && !track.enabled));
      const before = await guest.evaluate(() => ({ tasks: window.testTasks, lifecycle: window.testLifecycle.length, plays: window.testPlays.length, playing: window.testPlaying.length, captures: window.testCaptures.length }));
      await placeholder.bringToFront();
      await guestSession.send('Page.setWebLifecycleState', { state: 'frozen' });
      await delay(20000);
      assert.ok(!party.paused && !party.wantsPlay, 'The host must genuinely keep playing during the first twenty seconds of the guest’s sleep.');
      await post('control', { action: 'pause' });
      await post('control', { action: 'seek', position: 150 });
      await delay(45000);
      assert.ok(party.members.has(guestId), 'A connected sixty-five-second frozen client must still be inside the real ninety-second member lifetime.');
      assert.ok(Date.now() - party.members.get(guestId).lastSeen >= 60000, 'The frozen guest must actually stop JS heartbeat/readiness traffic during sleep.');
      assert.equal(party.currentPosition(), 150, 'A host’s paused seek must stay stationary throughout the remaining sleep.');
      await guestSession.send('Page.setWebLifecycleState', { state: 'active' });
      await guest.bringToFront();
      await guest.waitForFunction(() => {
        const v = document.querySelector('.movie-video');
        return v?.paused && v.readyState >= 3 && Math.abs(v.currentTime + window.testOffset - 150) < 1;
      }, undefined, { timeout: 60000 });
      const after = await guest.evaluate(before => ({ tasks: window.testTasks, lifecycle: window.testLifecycle.slice(before.lifecycle), plays: window.testPlays.slice(before.plays), playing: window.testPlaying.slice(before.playing),
        captures: window.testCaptures.length, audio: window.testTracks.filter(track => track.kind === 'audio' && track.readyState === 'live').map(track => ({ enabled: track.enabled, muted: track.muted })) }), before);
      assert.ok(after.lifecycle.some(event => event.type === 'freeze') && after.lifecycle.some(event => event.type === 'resume'), 'The long sleep must deliver genuine lifecycle suspension events.');
      assert.ok(after.lifecycle.find(event => event.type === 'resume').tasks - after.lifecycle.find(event => event.type === 'freeze').tasks <= 2, 'The sixty-five-second freeze must stop the real page timer until resume.');
      assert.ok(after.plays.every(play => play.state?.paused), 'Waking cannot request stale playing state after the host paused.');
      assert.ok(after.playing.every(event => event.paused), 'Waking to a paused host must not actually start stale video/audio, including native resumes.');
      assert.equal(after.captures, before.captures, 'Waking a retained call cannot reacquire devices.');
      assert.equal(after.audio.length, 1);
      assert.equal(after.audio[0].enabled, false, 'The deliberately muted native microphone must remain disabled after waking.');
      await guest.getByRole('button', { name: 'Turn on microphone', exact: true }).waitFor();
      await post('control', { action: 'play' });
      await stableAfterWake('Sixty-five-second wake', 1);
      await guest.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
      await guest.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor();
    });

    await run('Hundred-second genuine freeze expires safely and explicit rejoin catches current playback', async () => {
      // Begin with a refreshed real connection so the ninety-second lifetime is
      // measured from this sleep, rather than inherited from the first case.
      await guest.bringToFront();
      await guest.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await guest.waitForFunction(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length === 1);
      await guest.waitForFunction(playing, undefined, { timeout: 60000 });
      const before = await guest.evaluate(() => {
        window.testSuspendedMovie = document.querySelector('.movie-video');
        return { tasks: window.testTasks, lifecycle: window.testLifecycle.length, plays: window.testPlays.length, playing: window.testPlaying.length };
      });
      await placeholder.bringToFront();
      await guestSession.send('Page.setWebLifecycleState', { state: 'frozen' });
      await delay(20000);
      await post('control', { action: 'pause' });
      await post('control', { action: 'seek', position: 240 });
      await post('control', { action: 'play' });
      assert.ok(party.paused && party.wantsPlay, 'A sleeping connected viewer must not falsely acknowledge the new seek.');
      await delay(80000);
      assert.ok(!party.members.has(guestId), 'The sleep must exceed the actual ninety-second connected member lifetime.');
      assert.equal(party.ready.has(guestId), false, 'Expiry must remove the frozen client’s readiness.');
      assert.ok(!party.paused && !party.wantsPlay && party.currentPosition() > 240, 'The active host must resume once the expired viewer is removed.');
      await guestSession.send('Page.setWebLifecycleState', { state: 'active' });
      await guest.bringToFront();
      await guest.locator('#name').waitFor({ timeout: 30000 });
      assert.equal(await guest.locator('.inline-error').textContent(), 'Your session expired. Join again to reconnect.');
      await guest.waitForFunction(() => window.testTracks.every(track => track.readyState === 'ended') && window.testSuspendedMovie?.paused, undefined, { timeout: 30000 });
      const after = await guest.evaluate(before => ({ tasks: window.testTasks, lifecycle: window.testLifecycle.slice(before.lifecycle), plays: window.testPlays.slice(before.plays), playing: window.testPlaying.slice(before.playing),
        liveSockets: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length,
        liveTracks: window.testTracks.filter(track => track.readyState === 'live').length, outputs: document.querySelectorAll('audio.call-audio').length,
        position: window.testSuspendedMovie.currentTime }), before);
      assert.ok(after.lifecycle.some(event => event.type === 'freeze') && after.lifecycle.some(event => event.type === 'resume'));
      assert.ok(after.lifecycle.find(event => event.type === 'resume').tasks - after.lifecycle.find(event => event.type === 'freeze').tasks <= 2, 'The hundred-second freeze must stop the real page timer until resume.');
      assert.equal(after.liveSockets, 0, 'An expired client cannot own a live party state socket.');
      assert.equal(after.liveTracks, 0, 'An expired sleeping client must release microphone and camera.');
      assert.equal(after.outputs, 0, 'An expired call must detach its remote audio outputs.');
      assert.equal(after.plays.length, 0, 'An expired wake must not start the movie from queued old state.');
      assert.ok(after.playing.every(event => event.paused), 'An expired wake must not actually start stale movie audio, including native resumes.');
      await delay(2500);
      assert.equal(await guest.evaluate(() => window.testSuspendedMovie.currentTime), after.position, 'Expired movie playback cannot creep while waiting for an explicit rejoin.');
      await join(guest, 'Lifecycle Guest');
      await stableAfterWake('Hundred-second expiry and rejoin', 2);
    });
  }

  if (!longSleep) await run('Same-cookie second owner tab cannot trigger a reconnect fight', async () => {
    const oldSockets = await owner.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length);
    const replacement = await ownerContext.newPage(); replacement.on('pageerror', error => errors.push(error.message));
    await replacement.goto(origin); await join(replacement, 'Replacement Host', true);
    await replacement.waitForFunction(() => window.testSockets.some(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN));
    const replacementSockets = await replacement.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length);
    await delay(8000);
    const [oldResult, newResult] = await Promise.all([owner, replacement].map(page => page.evaluate(() => ({
      sockets: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length,
      live: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length,
      captures: window.testCaptures.length, nativeTracks: window.testTracks.filter(track => track.readyState === 'live').length,
      lifecycle: window.testLifecycle, playCalls: window.testPlays.length,
    }))));
    assert.equal(oldResult.live, 0, `A superseded tab must stop owning the party state socket: ${JSON.stringify({ oldResult, newResult })}`);
    assert.equal(oldResult.sockets, oldSockets, 'A superseded tab must not keep reconnecting with its shared browser cookie.');
    assert.equal(oldResult.nativeTracks, 0, 'A superseded tab must release its native microphone and camera.');
    await owner.locator('#name').waitFor();
    assert.equal(await owner.locator('.inline-error').textContent(), 'You joined in another tab.');
    assert.equal(newResult.live, 1);
    assert.equal(newResult.sockets, replacementSockets, 'The replacement host must retain a stable state connection.');
    assert.equal(newResult.captures, 1);
    assert.ok(party.members.get('owner')?.connected);
    await join(owner, 'Original Host Returns', true);
    await replacement.locator('#name').waitFor();
    await Promise.all([owner, guest].map(page => page.waitForFunction(playing, undefined, { timeout: 60000 })));
    await delay(2200);
    assert.equal(await owner.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length), 1);
    assert.equal(await replacement.evaluate(() => window.testTracks.filter(track => track.readyState === 'live').length), 0, 'Intentional takeover must dispose the superseded replacement tab’s devices.');
    assert.equal(await owner.evaluate(() => window.testCaptures.length), 2, 'Intentional rejoin obtains exactly one new combined capture.');
    await replacement.close();
  });
  assert.deepEqual(errors, [], 'Lifecycle testing must produce no browser exceptions.');
  assert.deepEqual(failures, [], 'All lifecycle failure cases must recover without stale playback or competing sessions.');
} finally {
  await guestSession?.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  await browser?.close().catch(() => {});
  try { await close(); }
  finally {
    chrome?.kill('SIGTERM'); await chromeExit;
    try { if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    finally { await call.deleteRoom(roomName).catch(() => {}); }
  }
}
