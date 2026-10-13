// Real movie/call playback under stale state and overlapping source changes.
// Isolated sessions and room; never saves Plex progress or touches the live party.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { RoomServiceClient } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const origin = 'http://localhost:5178', roomName = `playparty-control-race-${randomUUID()}`, ownerCookie = randomUUID();
const events = [], errors = [], releases = [], clients = [];
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const call = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const { server, party, close } = createApp({ plex, authenticateOwner: header => cookies(header).test_owner === ownerCookie,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', origin, roomName, recordProgress: false,
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined, logPlayback: sample => events.push(sample) });
let browser;
const playing = () => { const v = document.querySelector('.movie-video'); return v && !v.paused && v.readyState >= 3; };
const instrument = () => {
  window.testCaptures = []; window.testTracks = []; window.testPeers = []; window.testSockets = []; window.testPlaybackOffset = 0; window.testPlaybackVersion = 0;
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), NativePeer = RTCPeerConnection, NativeSocket = WebSocket, nativeFetch = fetch.bind(window);
  navigator.mediaDevices.getUserMedia = async constraints => { window.testCaptures.push(constraints); const stream = await capture(constraints); window.testTracks.push(...stream.getTracks()); return stream; };
  window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.testPeers.push(this); } };
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (new URL(response.url).pathname === '/api/playback' && response.ok) {
      const result = await response.clone().json(); window.testPlaybackOffset = Number(result.offset) || 0; window.testPlaybackVersion = result.mediaVersion;
    }
    return response;
  };
  window.WebSocket = class extends NativeSocket {
    constructor(...args) { super(...args); window.testSockets.push(this); }
    get onmessage() { return this.testHandler; }
    set onmessage(handler) {
      this.testHandler = handler;
      super.onmessage = event => {
        let state = false;
        if (typeof event.data === 'string') { try { state = JSON.parse(event.data).type === 'state'; } catch {} }
        if (state && window.testDropStates) { window.testDroppedStates = (window.testDroppedStates || 0) + 1; return; }
        if (state) this.testLastStateAt = Date.now();
        handler?.call(this, event);
      };
    }
  };
};
const join = async (page, owner = false) => {
  await page.locator('#name').fill(owner ? 'Test Host' : 'Test Guest');
  if (owner) await page.getByRole('switch', { name: 'I am the host' }).check();
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor({ timeout: 30000 });
};
const post = (action, body = {}) => clients[0].evaluate(async ({ action, body }) => {
  const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
}, { action, body });
const eventually = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(100);
  assert.ok(predicate(), label);
};
const assertCall = async (label, expectedCaptures = [1, 1]) => {
  for (let index = 0; index < clients.length; index++) {
    const page = clients[index];
    await page.waitForFunction(() => document.querySelectorAll('audio.call-audio').length === 1, undefined, { timeout: 30000 });
    const result = await page.evaluate(() => ({ captures: window.testCaptures.length,
      mic: window.testTracks.filter(t => t.kind === 'audio' && t.readyState === 'live').length,
      camera: window.testTracks.filter(t => t.kind === 'video' && t.readyState === 'live').length,
      outputs: document.querySelectorAll('audio.call-audio').length,
      connected: window.testPeers.some(peer => peer.connectionState === 'connected') }));
    assert.deepEqual(result, { captures: expectedCaptures[index], mic: 1, camera: 1, outputs: 1, connected: true }, `${label}: source races must preserve one live capture and one call output.`);
  }
};
const assertStable = async (label, expectedCaptures = [1, 1]) => {
  await Promise.all(clients.map(page => page.waitForFunction(playing, undefined, { timeout: 60000 })));
  await eventually(() => !party.paused && !party.wantsPlay && Date.now() > party.updatedAt + 1000, `${label}: shared playback must settle.`);
  let maxDrift = 0, maxSpread = 0, samples = 0;
  for (let index = 0; index < 12; index++) {
    const state = party.snapshot();
    const readings = await Promise.all(clients.map(page => page.evaluate(() => {
      const v = document.querySelector('.movie-video'); return { time: v.currentTime + window.testPlaybackOffset, at: Date.now(), paused: v.paused, ready: v.readyState, rate: v.playbackRate, version: window.testPlaybackVersion };
    })));
    const after = party.snapshot();
    const immutable = ['mediaVersion', 'readinessVersion', 'updatedAt', 'position'].every(key => state[key] === after[key]);
    if (immutable && !after.paused && !after.waiting && Date.now() > after.updatedAt + 1000) {
      const commonAt = Math.max(...readings.map(r => r.at));
      const times = readings.map(r => r.time + (r.paused ? 0 : (commonAt - r.at) * r.rate / 1000));
      for (const r of readings) {
        assert.equal(r.version, state.mediaVersion, `${label}: only the latest media generation may play.`);
        assert.ok(!r.paused && r.ready >= 3, `${label}: both players must advance decoded video.`);
        const drift = Math.abs(r.time - (state.position + Math.max(0, r.at - state.updatedAt) / 1000));
        maxDrift = Math.max(maxDrift, drift); assert.ok(drift < 1, `${label}: timeline drift ${drift.toFixed(3)}s must remain below one second.`);
      }
      const spread = Math.max(...times) - Math.min(...times); maxSpread = Math.max(maxSpread, spread); assert.ok(spread < 1, `${label}: viewer spread must remain below one second.`); samples++;
    }
    await delay(350);
  }
  assert.ok(samples >= 10, `${label}: at least ten immutable-clock samples are required.`);
  await assertCall(label, expectedCaptures);
  console.log(`${label}: ${samples} samples; max drift ${maxDrift.toFixed(3)}s; max viewer spread ${maxSpread.toFixed(3)}s.`);
};
// Complete a real Plex source response but delay delivery to this browser.
// Later seeks can start independently, so this targets genuinely stale responses.
const holdNextSource = async (page, status) => {
  let resolveSeen, release, held = false;
  const seen = new Promise(resolve => { resolveSeen = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); releases.push(release);
  const handler = async route => {
    if (held) return route.continue();
    held = true;
    try {
      const response = await route.fetch(); resolveSeen(); await gate;
      if (status) await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'Test source unavailable.' }) });
      else await route.fulfill({ response });
    } catch (error) {
      // Replaced/left players intentionally abort their obsolete fetch.
      if (!/closed|aborted|disposed|cancel|already handled|ERR_FAILED/i.test(error.message)) throw error;
    }
  };
  await page.route('**/api/playback', handler);
  const bounded = Promise.race([seen, delay(30000, undefined, { ref: false }).then(() => { throw Error('The delayed source response did not arrive within thirty seconds.'); })]);
  return { seen: bounded, release, remove: () => page.unroute('**/api/playback', handler) };
};
try {
  await call.createRoom({ name: roomName });
  await new Promise(resolve => server.listen(5178, '127.0.0.1', resolve));
  const movies = (await plex.library()).filter(item => item.type === 'movie');
  assert.ok(movies.length >= 2, 'The race tests require two real movies.');
  const selected = movies.find(item => item.title === process.env.TEST_MOVIE) || movies[0];
  const movie = plex.simplify(await plex.metadata(selected.id));
  const replacement = movies.find(item => item.id !== selected.id);
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] }); await context.addInitScript(instrument);
    if (!index) await context.addCookies([{ name: 'test_owner', value: ownerCookie, url: origin }]);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); clients.push(page); await page.goto(origin); await join(page, !index);
  }
  const [owner, guest] = clients;
  await post('select', { id: movie.id });
  await post('control', { action: 'seek', position: Math.min(120, movie.duration / 4) });
  await assertStable('Initial playback');

  // Personal caption changes replace only this viewer's source, without a
  // shared media-generation change. Readiness from before a manual pause must
  // therefore be revoked explicitly, including when the replacement fails.
  let captionMovie = movie;
  for (const candidate of movies) {
    if (captionMovie.subtitles?.some(track => !track.burn)) break;
    captionMovie = plex.simplify(await plex.metadata(candidate.id));
  }
  const caption = captionMovie.subtitles?.find(track => !track.burn);
  assert.ok(caption, 'The paused source test requires a real movie with a text subtitle track.');
  if (captionMovie.id !== movie.id) { await post('select', { id: captionMovie.id }); await assertStable('Caption fixture playback'); }
  await post('control', { action: 'pause' });
  for (const page of clients) await page.waitForFunction(() => document.querySelector('.movie-video').paused);
  let held = await holdNextSource(guest, 404);
  const pausedVersion = party.mediaVersion, pausedPosition = party.currentPosition();
  const guestId = [...party.members.keys()].find(id => id !== 'owner');
  await guest.getByRole('combobox', { name: 'Subtitles', exact: true }).selectOption(caption.id); await held.seen;
  await eventually(() => !party.ready.has(guestId), 'A personal source replacement while paused must revoke its old readiness.');
  assert.equal(party.paused, true); assert.equal(party.wantsPlay, false, 'Caption changes cannot turn an intentional pause into a playback request.');
  assert.equal(party.mediaVersion, pausedVersion, 'Personal subtitles cannot change the shared media generation.');
  await post('control', { action: 'play' });
  assert.ok(party.paused && party.wantsPlay, 'Play must wait for the paused viewer whose replacement source is still loading.');
  held.release(); await guest.getByRole('button', { name: 'Retry movie', exact: true }).waitFor();
  await delay(2200); assert.equal(party.currentPosition(), pausedPosition, 'A failed replacement cannot advance the shared movie clock.');
  for (const page of clients) assert.equal(await page.locator('.movie-video').evaluate(v => v.paused), true);
  await assertCall('Paused personal source fault');
  await guest.getByRole('button', { name: 'Retry movie', exact: true }).click();
  await held.remove(); await assertStable('Paused personal source failure and movie retry');
  if (captionMovie.id !== movie.id) { await post('select', { id: movie.id }); await assertStable('Original movie restored'); }

  // A stale guest misses the host pause. Reconnecting must not resurrect play.
  const sockets = await guest.evaluate(() => { window.testDropStates = true; return window.testSockets.filter(s => new URL(s.url).pathname === '/events').length; });
  await post('control', { action: 'pause' });
  await owner.waitForFunction(() => document.querySelector('.movie-video').paused);
  await guest.waitForFunction(count => document.querySelector('.movie-video').paused && window.testSockets.filter(s => new URL(s.url).pathname === '/events').length > count, sockets, { timeout: 15000 });
  const heldPosition = party.currentPosition();
  await guest.evaluate(() => { window.testDropStates = false; window.testUnexpectedPlay = 0; document.querySelector('.movie-video').addEventListener('play', () => { window.testUnexpectedPlay++; }); });
  await delay(2600);
  assert.equal(party.currentPosition(), heldPosition, 'Reconnect after a missed host pause must preserve the intentionally frozen shared clock.');
  for (const page of clients) assert.equal(await page.locator('.movie-video').evaluate(v => v.paused), true);
  assert.equal(await guest.evaluate(() => window.testUnexpectedPlay), 0, 'Fresh paused state must not create a late play/audio burst.');
  assert.ok(await guest.evaluate(() => window.testDroppedStates >= 2), 'The guest must miss multiple actual state broadcasts.');
  await assertCall('Reconnect to paused state');
  console.log('Missed host pause: stale guest stopped, reconnected, and remained paused without a late play event.');
  await post('control', { action: 'play' }); await assertStable('Playback after stale paused reconnect');

  // A departed unready viewer must not block the remaining viewer forever.
  held = await holdNextSource(guest);
  await post('control', { action: 'seek', position: Math.min(180, movie.duration / 3) }); await held.seen;
  await eventually(() => party.paused && party.wantsPlay, 'A delayed guest source must hold shared playback.');
  const waitingAt = party.currentPosition(); await delay(1200); assert.equal(party.currentPosition(), waitingAt);
  await guest.getByRole('button', { name: 'Leave the call', exact: true }).click(); await guest.locator('#name').waitFor();
  await owner.waitForFunction(playing, undefined, { timeout: 30000 });
  assert.equal(party.members.size, 1, 'Leaving must remove the unready viewer.');
  assert.ok(!party.paused && !party.wantsPlay, 'Remaining buffered viewers must resume when the unready viewer leaves.');
  held.release(); await held.remove(); await delay(500);
  assert.equal(await guest.locator('.movie-video').count(), 0, 'The old response cannot revive a player after Leave.');
  await join(guest); await assertStable('Slow viewer leave and return', [1, 2]);

  // Several host seeks race with a delayed, valid older source response.
  held = await holdNextSource(guest);
  await post('control', { action: 'seek', position: Math.min(200, movie.duration / 3) }); await held.seen;
  const oldVersion = party.mediaVersion;
  await post('control', { action: 'seek', position: Math.min(280, movie.duration / 2) });
  await post('control', { action: 'seek', position: Math.min(360, movie.duration * 0.6) });
  assert.equal(party.mediaVersion, oldVersion + 2, 'Every seek must create a fresh media generation.');
  held.release(); await held.remove();
  await assertStable('Consecutive seeks with stale response', [1, 2]);

  // Stop removes both players even with an outstanding source response; the
  // next selected film must remain selected after that old response arrives.
  held = await holdNextSource(guest);
  await post('control', { action: 'seek', position: Math.min(400, movie.duration * 0.7) }); await held.seen;
  const stopVersion = party.mediaVersion; await post('stop');
  for (const page of clients) await page.waitForFunction(() => !document.querySelector('.movie-video'));
  assert.equal(party.movie, null); assert.equal(party.mediaVersion, stopVersion + 1);
  await post('select', { id: replacement.id });
  await Promise.all(clients.map(page => page.waitForFunction(playing, undefined, { timeout: 60000 })));
  const replacementVersion = party.mediaVersion; held.release(); await held.remove();
  await assertStable('Stop and replace during delayed response', [1, 2]);
  assert.equal(party.movie.id, replacement.id); assert.equal(party.mediaVersion, replacementVersion, 'The stale old source must not change the replacement movie.');
  assert.deepEqual(errors, [], 'Source races must not produce browser exceptions.');
  assert.ok(events.filter(e => e.event === 'stream-start').length >= 8, 'The checks must exercise actual Plex source creation.');
  console.log('Five control-race faults passed; calls retained clean captures and outputs.');
} finally {
  for (const release of releases) release();
  await browser?.close(); await close(); await call.deleteRoom(roomName).catch(() => {});
}
