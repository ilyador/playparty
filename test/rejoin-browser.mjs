// Real Plex/LiveKit playback across leaving, joining, and reconnecting.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const testOwner = randomUUID();
const events = [];
const { server, party, close } = createApp({ plex, authenticateOwner: header => cookies(header).test_owner === testOwner,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitUrl: 'ws://localhost:7880', origin: 'http://localhost:5176', roomName: `playparty-rejoin-test-${randomUUID()}`, recordProgress: false,
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined, logPlayback: sample => events.push(sample) });
await new Promise(resolve => server.listen(5176, '127.0.0.1', resolve));
let browser;
const playing = () => { const v = document.querySelector('.movie-video'); return v && v.readyState >= 3 && v.currentTime > 2 && !v.paused; };
try {
  const library = (await plex.library()).filter(item => item.type === 'movie');
  const item = library.find(item => item.title === process.env.TEST_MOVIE) || library[0];
  assert.ok(item, 'The Plex library must contain a movie.');
  const movie = plex.simplify(await plex.metadata(item.id));
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ownerContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  for (const context of [ownerContext, guestContext]) await context.addInitScript(() => {
    const Native = window.WebSocket, NativePeer = window.RTCPeerConnection;
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.testSockets = [];
    window.testPeers = []; window.testMediaRequests = []; window.testPlaybackReports = [];
    navigator.mediaDevices.getUserMedia = constraints => { window.testMediaRequests.push(constraints); return getMedia(constraints); };
    window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.testPeers.push(this); } };
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); this.testDropStates = Boolean(window.testDropAllStates); window.testSockets.push(this); }
      send(data) {
        if (typeof data === 'string') { try { const message = JSON.parse(data); if (message.type === 'telemetry') window.testPlaybackReports.push(message); } catch {} }
        return super.send(data);
      }
      get onmessage() { return this.testMessageHandler; }
      set onmessage(handler) {
        this.testMessageHandler = handler;
        super.onmessage = event => {
          let state = false;
          if (typeof event.data === 'string') { try { state = JSON.parse(event.data).type === 'state'; } catch {} }
          if (state && this.testDropStates) { this.testDroppedStates = (this.testDroppedStates || 0) + 1; return; }
          if (state) this.testLastStateAt = Date.now();
          handler?.call(this, event);
        };
      }
    };
  });
  await ownerContext.addCookies([{ name: 'test_owner', value: testOwner, url: 'http://localhost:5176' }]);
  const owner = await ownerContext.newPage();
  const guest = await guestContext.newPage();
  const errors = [];
  for (const page of [owner, guest]) page.on('pageerror', error => errors.push(error.message));
  const join = async (page, name, host = false) => {
    await page.locator('#name').fill(name);
    if (host) await page.getByRole('switch', { name: 'I am the host' }).check();
    await page.getByRole('button', { name: 'Join', exact: true }).click();
  };
  const post = (action, body = {}) => owner.evaluate(async ({ action, body }) => {
    const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    return data;
  }, { action, body });
  await owner.goto('http://localhost:5176');
  await join(owner, 'Test Host', true);
  await post('select', { id: movie.id });
  await owner.waitForFunction(playing, undefined, { timeout: 60000 });
  await guest.goto('http://localhost:5176');
  await join(guest, 'Test Guest');
  await guest.waitForFunction(playing, undefined, { timeout: 60000 });
  const position = Math.min(600, Math.max(10, movie.duration / 3));
  await post('control', { action: 'seek', position });
  for (const page of [owner, guest]) await page.waitForFunction(position => { const v = document.querySelector('.movie-video'); return v && !v.paused && v.readyState >= 3 && v.currentTime >= position; }, position, { timeout: 60000 });

  async function assertSynchronized(label) {
    const samples = await Promise.all([owner, guest].map(page => page.evaluate(async () => {
      const state = (await (await fetch('/api/session')).json()).state;
      const v = document.querySelector('.movie-video');
      const target = state.position + (state.paused ? 0 : Math.max(0, state.serverTime - state.updatedAt) / 1000);
      return { position: v.currentTime, target, paused: v.paused, waiting: state.waiting };
    })));
    for (const sample of samples) {
      assert.ok(!sample.paused && !sample.waiting, `${label}: both clients must be playing after rejoin.`);
      assert.ok(Math.abs(sample.position - sample.target) < 1, `${label}: a rejoined client must follow the current shared timeline. ${JSON.stringify(samples)}`);
    }
    assert.ok(Math.abs(samples[0].position - samples[1].position) < 1, `${label}: clients must remain within one second. ${JSON.stringify(samples)}`);
  }
  await assertSynchronized('Before rejoin');
  for (const page of [owner, guest]) await page.evaluate(() => { window.originalMovieElement = document.querySelector('.movie-video'); });

  for (const [page, name, host] of [[guest, 'Test Guest', false], [owner, 'Test Host', true]]) {
    await page.getByRole('button', { name: 'Leave the call', exact: true }).click();
    await page.locator('#name').waitFor();
    assert.equal(party.paused, false, 'Leaving must not pause the remaining viewer.');
    await page.waitForTimeout(2500);
    let delayed = false;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/stream/**', async route => {
      if (!delayed) { delayed = true; await held; }
      await route.continue();
    });
    await join(page, name, host);
    await page.waitForFunction(() => Boolean(document.querySelector('.movie-video')));
    const deadline = Date.now() + 15000;
    while ((!delayed || !party.wantsPlay) && Date.now() < deadline) await page.waitForTimeout(100);
    assert.ok(delayed && party.paused && party.wantsPlay, 'A rejoin must wait for fresh playback readiness.');
    const heldPosition = party.currentPosition();
    await page.waitForTimeout(2500);
    assert.equal(party.currentPosition(), heldPosition, 'A slow rejoin must hold one shared clock.');
    // Reconnecting while another viewer is still loading must invalidate the
    // remaining player's cached readiness, then validate its retained buffer.
    const remaining = page === guest ? owner : guest;
    const readyBeforeReconnect = events.filter(event => event.event === 'viewer-ready').length;
    const socketsBeforeReconnect = await remaining.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length);
    await remaining.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').at(-1).close());
    await remaining.waitForFunction(count => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length > count, socketsBeforeReconnect, { timeout: 10000 });
    await remaining.waitForTimeout(1200);
    assert.ok(party.paused && party.wantsPlay, 'A socket reconnect cannot resume a viewer whose new stream is still loading.');
    assert.ok(events.filter(event => event.event === 'viewer-ready').length > readyBeforeReconnect, 'Retained playback must prove readiness again after reconnecting.');
    release();
    for (const viewer of [owner, guest]) await viewer.waitForFunction(playing, undefined, { timeout: 60000 });
    await page.unroute('**/api/stream/**');
    await page.waitForTimeout(2500);
    await assertSynchronized(host ? 'Host rejoin' : 'Guest rejoin');
    assert.equal(await page.evaluate(() => window.originalMovieElement === document.querySelector('.movie-video')), true, 'Leave/rejoin must retain the video element authorized by the original Join tap.');
    for (const viewer of [owner, guest]) {
      await viewer.waitForFunction(() => document.querySelectorAll('audio.call-audio').length === 1, undefined, { timeout: 15000 });
      assert.equal(await viewer.locator('audio.call-audio').count(), 1, 'Rejoin must retain exactly one remote call output.');
    }
    console.log(`${host ? 'Host' : 'Guest'} leave/rejoin resumed on the current movie timeline after fresh buffering.`);
  }
  for (const [page, name, host] of [[guest, 'Test Guest', false], [owner, 'Test Host', true]]) {
    await page.reload();
    await page.locator('#name').waitFor();
    await join(page, name, host);
    for (const viewer of [owner, guest]) await viewer.waitForFunction(playing, undefined, { timeout: 60000 });
    await page.waitForTimeout(2500);
    await assertSynchronized(host ? 'Host refresh' : 'Guest refresh');
    assert.ok(party.members.get('owner')?.connected, 'The old socket close cannot disconnect a rejoined host.');
    console.log(`${host ? 'Host' : 'Guest'} page refresh and rejoin followed the live shared position.`);
  }
  const callOutputs = events.filter(event => event.event === 'call-audio-output');
  assert.ok(new Set(callOutputs.filter(event => event.callAudioTracks === 1 && event.callAudioElements === 1).map(event => event.viewer)).size >= 2, 'Both clients must report one remote call audio track and element.');
  assert.ok(callOutputs.every(event => event.callAudioDuplicates === 0 && event.callAudioUnexpected === 0), 'Rejoin must not create duplicated or unexpected call audio.');

  await guest.evaluate(() => {
    const v = document.querySelector('.movie-video');
    v.testNativePlay = v.play.bind(v);
    v.pause();
    let blocked = false;
    v.play = () => {
      if (!blocked) { blocked = true; return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError')); }
      return v.testNativePlay();
    };
  });
  await guest.getByRole('button', { name: 'Start playback', exact: true }).waitFor();
  assert.equal(await guest.locator('.watch-prompt').count(), 0, 'A blocked guest must use the existing transport instead of a movie overlay.');
  const gestureDeadline = Date.now() + 10000;
  while (!party.wantsPlay && Date.now() < gestureDeadline) await guest.waitForTimeout(100);
  assert.ok(party.paused && party.wantsPlay, 'A guest blocked by browser autoplay must hold the shared clock.');
  const blockedPosition = party.currentPosition();
  const blockedLocalPosition = await guest.locator('.movie-video').evaluate(v => v.currentTime);
  await guest.waitForTimeout(2200);
  assert.equal(party.currentPosition(), blockedPosition);
  assert.equal(await guest.locator('.movie-video').evaluate(v => v.currentTime), blockedLocalPosition, 'A blocked guest cannot appear to play through repeated synchronization seeks.');
  await guest.getByRole('button', { name: 'Start playback', exact: true }).click();
  for (const viewer of [owner, guest]) await viewer.waitForFunction(playing, undefined, { timeout: 60000 });
  await guest.waitForFunction(() => !document.querySelector('.playback-blocked'));
  await guest.evaluate(() => { const v = document.querySelector('.movie-video'); v.play = v.testNativePlay; });
  await assertSynchronized('Guest browser playback permission');
  console.log('A blocked guest held both the shared clock and its local frame, then resumed through the compact Start playback control.');

  // Model the real phone trace: media retains readyState 4 and buffered data
  // but seeking never completes. The shared clock must stop before a new
  // source is created at the held position.
  await guest.waitForFunction(() => { const v = document.querySelector('.movie-video'); return v?.readyState === 4 && [...Array(v.buffered.length).keys()].some(i => v.buffered.end(i) - v.currentTime >= 6); });
  const streamsBeforeStall = events.filter(event => event.event === 'stream-start').length;
  const recoveryRequest = guest.waitForRequest(request => request.url().endsWith('/api/playback'), { timeout: 20000 });
  await guest.evaluate(() => {
    const v = document.querySelector('.movie-video');
    v.pause();
    Object.defineProperty(v, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(v, 'seeking', { configurable: true, get: () => true });
  });
  const deadline = Date.now() + 10000;
  while (!party.wantsPlay && Date.now() < deadline) await guest.waitForTimeout(100);
  assert.ok(party.paused && party.wantsPlay, 'A media seek stuck with readyState 4 must hold the shared clock.');
  const stoppedAt = party.currentPosition();
  await guest.waitForTimeout(2500);
  assert.equal(party.currentPosition(), stoppedAt, 'The shared clock cannot advance while that seek is stuck.');
  await recoveryRequest;
  await guest.evaluate(() => { const v = document.querySelector('.movie-video'); delete v.paused; delete v.seeking; });
  for (const viewer of [owner, guest]) await viewer.waitForFunction(playing, undefined, { timeout: 60000 });
  assert.ok(events.filter(event => event.event === 'stream-start').length > streamsBeforeStall, 'A buffered seek that never lands must replace this viewer’s source.');
  assert.ok(await guest.evaluate(() => window.testPlaybackReports.some(sample => sample.event === 'seek-recovery')), 'Seek recovery must emit diagnostics even when the server rate-limits adjacent samples.');
  await assertSynchronized('Stuck seek recovery');
  console.log('A stuck seek held the clock and replaced only its failing viewer’s stream before synchronized playback resumed.');

  for (const page of [owner, guest]) {
    await page.waitForFunction(() => document.querySelectorAll('audio.call-audio').length === 1, undefined, { timeout: 15000 });
    await page.evaluate(() => {
      window.testCallPeers = window.testPeers.filter(peer => peer.connectionState === 'connected');
      window.testCallPeerCount = window.testPeers.length; window.testCallCaptures = window.testMediaRequests.length;
    });
  }
  const assertCallRetained = async label => {
    for (const page of [owner, guest]) assert.deepEqual(await page.evaluate(() => ({
      captures: window.testMediaRequests.length === window.testCallCaptures,
      peers: window.testPeers.length === window.testCallPeerCount && window.testCallPeers.length > 0 && window.testCallPeers.every(peer => window.testPeers.includes(peer) && peer.connectionState === 'connected'),
      outputs: document.querySelectorAll('audio.call-audio').length,
    })), { captures: true, peers: true, outputs: 1 }, `${label}: playback recovery must retain the connected call without new capture or duplicate output.`);
  };

  // A decoder can keep reporting buffered data and seeking=false while its
  // playback position is stuck. Ignore hard seeks until the watchdog replaces
  // only this client's source, then release the native media engine.
  // Use the other viewer so the earlier stuck-seek recovery's per-player
  // thirty-second reload cooldown does not hide this independent fault.
  const affected = owner, affectedId = 'owner';
  await affected.waitForFunction(() => { const v = document.querySelector('.movie-video'); return v?.readyState === 4 && v.currentTime > 6 && [...Array(v.buffered.length).keys()].some(i => v.buffered.start(i) <= v.currentTime - 5 && v.buffered.end(i) - v.currentTime >= 6); });
  const driftEventsAt = events.length;
  let driftReloads = 0;
  await affected.route('**/api/playback', async route => {
    driftReloads++;
    await affected.evaluate(() => {
      const v = document.querySelector('.movie-video');
      delete v.currentTime; delete v.paused; delete v.seeking;
    });
    await route.continue();
  });
  await affected.evaluate(() => {
    const v = document.querySelector('.movie-video'), stuckAt = v.currentTime - 5;
    v.pause();
    window.testIgnoredCorrections = 0;
    Object.defineProperty(v, 'currentTime', { configurable: true, get: () => stuckAt, set: () => { window.testIgnoredCorrections++; } });
    Object.defineProperty(v, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(v, 'seeking', { configurable: true, get: () => false });
  });
  await affected.waitForRequest(request => request.url().endsWith('/api/playback'), { timeout: 20000 });
  for (const page of [owner, guest]) await page.waitForFunction(playing, undefined, { timeout: 60000 });
  await guest.waitForTimeout(2500);
  await assertSynchronized('Failed synchronization corrections');
  await guest.waitForTimeout(2500);
  assert.equal(driftReloads, 1, 'Repeated ignored synchronization corrections must cause one bounded source reload.');
  const driftStreams = events.slice(driftEventsAt).filter(event => event.event === 'stream-start');
  assert.deepEqual(driftStreams.map(event => event.viewer), [affectedId], 'Synchronization recovery must restart only the affected viewer stream.');
  assert.ok(await affected.evaluate(() => window.testIgnoredCorrections >= 2), 'The watchdog must first attempt ordinary synchronization corrections.');
  assert.ok(await affected.evaluate(() => window.testPlaybackReports.some(sample => sample.event === 'sync-recovery')));
  await affected.unroute('**/api/playback');
  await assertCallRetained('Failed correction recovery');
  console.log('Two ineffective hard corrections replaced only the stuck viewer stream and recovered within one second while retaining the call.');

  // Drop snapshots while leaving the socket and pong traffic healthy. Movie
  // playback must stop trusting its old clock, then reconnect for fresh state.
  const staleAt = await guest.evaluate(() => {
    const ws = window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').at(-1);
    window.testDropAllStates = true; ws.testDropStates = true;
    window.testStaleSocket = ws;
    return { stateAt: ws.testLastStateAt, sockets: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length };
  });
  await guest.waitForFunction(() => {
    const v = document.querySelector('.movie-video');
    return v.paused && window.testStaleSocket.readyState !== WebSocket.OPEN;
  }, undefined, { timeout: 12000 });
  const staleStopped = await guest.locator('.movie-video').evaluate(v => v.currentTime);
  const staleElapsed = Date.now() - staleAt.stateAt;
  assert.ok(staleElapsed >= 8000 && staleElapsed < 12000, `A client must reject an eight-second stale timeline promptly (${staleElapsed} ms).`);
  assert.ok(await guest.evaluate(() => window.testStaleSocket.testDroppedStates >= 2), 'The stale connection must have silently lost multiple real state broadcasts.');
  await guest.waitForTimeout(1000);
  assert.equal(await guest.locator('.movie-video').evaluate(v => v.currentTime), staleStopped, 'A stale client must pause its local movie instead of advancing on an outdated clock.');
  await assertCallRetained('Stale state hold');
  await guest.evaluate(() => {
    window.testDropAllStates = false;
    for (const socket of window.testSockets) socket.testDropStates = false;
  });
  await guest.waitForFunction(count => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length > count, staleAt.sockets, { timeout: 10000 });
  for (const page of [owner, guest]) await page.waitForFunction(playing, undefined, { timeout: 60000 });
  await guest.waitForTimeout(2500);
  await assertSynchronized('Silent state socket recovery');
  await assertCallRetained('Fresh state reconnect');
  console.log('An eight-second stale snapshot paused the client movie, reconnected for current state, and resynchronized without reconnecting the call.');

  const beforeForeground = party.snapshot();
  const socketsBeforeForeground = await guest.evaluate(() => {
    const count = window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length;
    document.dispatchEvent(new Event('visibilitychange'));
    return count;
  });
  assert.equal(await guest.locator('.movie-video').evaluate(video => video.paused), false, 'A healthy foreground transition cannot pause local playback.');
  assert.equal(party.readinessVersion, beforeForeground.readinessVersion, 'A healthy foreground transition cannot revoke shared readiness.');
  assert.equal(party.updatedAt, beforeForeground.updatedAt, 'A healthy foreground transition cannot restart the shared clock.');
  assert.equal(await guest.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').length), socketsBeforeForeground, 'A healthy foreground transition must retain the existing socket.');
  await guest.waitForTimeout(2500);
  await assertSynchronized('Healthy foreground');
  await assertCallRetained('Healthy foreground');
  console.log('A healthy foreground transition retained movie playback, the shared clock and the existing call.');
  assert.deepEqual(errors, []);
  assert.ok(events.some(event => event.event === 'join-wait'));
} finally {
  await browser?.close();
  await close();
}
