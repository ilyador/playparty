// Real Plex/LiveKit faults which outlast ordinary retries or participant expiry.
// One Chrome process, two contexts, isolated owner/room; no Plex progress writes.
// Faults cut real movie HTTP/party WS traffic, not physical WebRTC UDP.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { RoomServiceClient } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const origin = 'http://localhost:5177';
const roomName = `playparty-network-fault-${randomUUID()}`, ownerCookie = randomUUID();
const errors = [], findings = [], clients = [];
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const call = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const { server, party, close } = createApp({ plex, authenticateOwner: header => cookies(header).test_owner === ownerCookie,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', origin, roomName, recordProgress: false,
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined });
let browser, blockEvents = false, blockedCookie, rejectedHandshakes = 0;
server.prependListener('upgrade', (req, socket) => {
  if (blockEvents && req.url === '/events' && cookies(req.headers.cookie).playparty_session === blockedCookie) { rejectedHandshakes++; socket.destroy(); }
});
const instrument = () => {
  const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), NativePeer = RTCPeerConnection, NativeSocket = WebSocket;
  window.testCaptures = []; window.testTracks = []; window.testPeers = []; window.testSockets = [];
  navigator.mediaDevices.getUserMedia = async constraints => { window.testCaptures.push(constraints); const stream = await nativeCapture(constraints); window.testTracks.push(...stream.getTracks()); return stream; };
  window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.testPeers.push(this); } };
  window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.testSockets.push(this); } };
};
const playing = () => { const v = document.querySelector('.movie-video'); return v && !v.paused && v.readyState >= 3 && v.currentTime > 2; };
const join = async client => {
  await client.page.locator('#name').fill(client.host ? 'Test Host' : 'Test Guest');
  if (client.host) await client.page.getByRole('switch', { name: 'I am the host' }).check();
  await client.page.getByRole('button', { name: 'Join', exact: true }).click();
  await client.page.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor({ timeout: 30000 });
};
const post = (action, body = {}) => clients[0].page.evaluate(async ({ action, body }) => {
  const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
}, { action, body });
const waitPlaying = async (timeout = 60000) => { await Promise.all(clients.map(client => client.page.waitForFunction(playing, undefined, { timeout }))); };
const assertCall = async label => {
  for (const client of clients) assert.deepEqual(await client.page.evaluate(() => ({ captures: window.testCaptures.length, microphone: window.testTracks.filter(track => track.kind === 'audio' && track.readyState === 'live').length,
    camera: window.testTracks.filter(track => track.kind === 'video' && track.readyState === 'live').length, outputs: document.querySelectorAll('audio.call-audio').length,
    connected: window.testPeers.some(peer => peer.connectionState === 'connected') })), { captures: client.expectedCaptures, microphone: 1, camera: 1, outputs: 1, connected: true }, `${label}: retain the call and exactly one capture/output.`);
};
// Immutable shared-clock samples and ten continuous stable seconds.
const assertStable = async label => {
  await waitPlaying(); await delay(1500);
  const deadline = Date.now() + 45000;
  let stableSince = Date.now(), samples = 0, maxDrift = 0, maxSpread = 0, heldPosition, heldVersion;
  while (Date.now() < deadline && Date.now() - stableSince < 10000) {
    const before = party.snapshot();
    const readings = await Promise.all(clients.map(client => client.page.evaluate(() => { const v = document.querySelector('.movie-video'); return { time: v.currentTime, at: Date.now(), paused: v.paused, ready: v.readyState, rate: v.playbackRate }; })));
    const after = party.snapshot();
    const sameClock = ['mediaVersion', 'readinessVersion', 'updatedAt', 'position'].every(key => before[key] === after[key]);
    if (before.waiting && after.waiting && sameClock) {
      assert.equal(before.paused, true, `${label}: buffering pauses the shared clock.`);
      if (heldPosition !== undefined && heldVersion === before.readinessVersion) assert.equal(party.currentPosition(), heldPosition, `${label}: a buffer hold cannot advance its clock.`);
      else { heldPosition = party.currentPosition(); heldVersion = before.readinessVersion; }
    } else heldPosition = undefined;
    if (before.waiting || after.waiting || before.paused || after.paused || !sameClock || Date.now() < after.updatedAt + 1000) stableSince = Date.now();
    else {
      const commonAt = Math.max(...readings.map(reading => reading.at));
      const projected = readings.map(reading => reading.time + (reading.paused ? 0 : (commonAt - reading.at) * reading.rate / 1000));
      for (const reading of readings) {
        const drift = Math.abs(reading.time - (before.position + Math.max(0, reading.at - before.updatedAt) / 1000)); maxDrift = Math.max(maxDrift, drift);
        assert.ok(!reading.paused && reading.ready >= 3, `${label}: actual decoded playback must advance.`);
        assert.ok(drift < 1, `${label}: shared timeline drift ${drift.toFixed(3)}s must remain below one second.`);
      }
      const spread = Math.max(...projected) - Math.min(...projected); maxSpread = Math.max(maxSpread, spread);
      assert.ok(spread < 1, `${label}: viewer spread ${spread.toFixed(3)}s must remain below one second.`); samples++;
    }
    await delay(500);
  }
  assert.ok(Date.now() - stableSince >= 10000 && samples >= 15, `${label}: ten continuous stable seconds required.`);
  await assertCall(label);
  console.log(`${label}: ${samples} immutable-clock samples; max drift ${maxDrift.toFixed(3)}s; spread ${maxSpread.toFixed(3)}s.`);
};
const isRecovered = async (timeout = 12000) => {
  try { await waitPlaying(timeout); return !party.paused && !party.wantsPlay; } catch { return false; }
};
const manualReconnect = async client => {
  await client.page.reload(); await client.page.locator('#name').waitFor(); await join(client); await waitPlaying();
};
try {
  await call.createRoom({ name: roomName });
  await new Promise(resolve => server.listen(5177, '127.0.0.1', resolve));
  const library = (await plex.library()).filter(item => item.type === 'movie');
  const item = library.find(item => item.title === process.env.TEST_MOVIE) || library[0]; assert.ok(item, 'A Plex movie is required.');
  const movie = plex.simplify(await plex.metadata(item.id));
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  for (let index = 0; index < 2; index++) {
    const client = { host: index === 0, expectedCaptures: 1, context: await browser.newContext({ permissions: ['camera', 'microphone'] }) }; clients.push(client);
    await client.context.addInitScript(instrument);
    if (client.host) await client.context.addCookies([{ name: 'test_owner', value: ownerCookie, url: origin }]);
    client.page = await client.context.newPage(); client.page.on('pageerror', error => errors.push(error.message));
    await client.page.goto(origin); await join(client);
  }
  const guest = clients[1];
  await post('select', { id: movie.id }); await waitPlaying();
  const start = Math.min(600, Math.max(10, movie.duration / 3));
  await post('control', { action: 'seek', position: start });
  await assertStable('Two-client baseline');

  // Media requests fail for longer than Hls retry budgets; party/call stay live.
  let blockedMedia = 0;
  await guest.page.route('**/api/stream/**', async route => { blockedMedia++; await route.abort('connectionrefused'); });
  await post('control', { action: 'seek', position: start + 30 });
  const outageAt = Date.now();
  await delay(65000);
  assert.ok(blockedMedia >= 1, 'The outage must reject at least one real cold movie HTTP request.');
  assert.ok(party.paused && party.wantsPlay, 'A media outage must hold the shared timeline.');
  const held = party.currentPosition(); await delay(1500); assert.equal(party.currentPosition(), held, 'The held shared clock cannot advance.');
  await assertCall('Long media outage');
  await guest.page.unroute('**/api/stream/**');
  if (await isRecovered(35000)) await assertStable('Long movie HTTP outage restored');
  else {
    const errorShown = await guest.page.locator('.player-error').count();
    findings.push('A 65-second movie HTTP outage exhausts retries and restoration alone never restarts the movie.');
    console.log(`UNHANDLED long movie HTTP outage: ${blockedMedia} blocked requests; ${Date.now() - outageAt}ms elapsed; error visible=${errorShown}; call retained and shared clock held.`);
    await manualReconnect(guest); await assertStable('Manual reconnect after media outage');
  }

  // Configuration faults occur on a fresh seek with valid auth and socket.
  // A 503 or empty 200 retries; a permanent 404 gets explicit movie-only Retry.
  for (const status of [503, 200, 404]) {
    let requests = 0, faultResponses = 0;
    let sawFault, releaseFault;
    const faultStarted = new Promise(resolve => { sawFault = resolve; });
    const release = new Promise(resolve => { releaseFault = resolve; });
    await guest.page.route('**/api/playback', async route => {
      requests++;
      if (requests === 1) { faultResponses++; sawFault(); await release; await route.fulfill({ status, contentType: 'application/json', body: status === 200 ? '' : JSON.stringify({ error: 'Test playback fault.' }) }); }
      else await route.continue();
    });
    await post('control', { action: 'seek', position: start + (status === 503 ? 60 : status === 200 ? 75 : 90) });
    await Promise.race([faultStarted, delay(10000).then(() => { throw Error('A fresh seek must make a real playback configuration request.'); })]);
    const held = party.currentPosition(); assert.ok(party.paused && party.wantsPlay);
    await delay(1500); assert.equal(party.currentPosition(), held);
    await assertCall(`Playback API ${status} hold`);
    releaseFault();
    if (status !== 404) {
      if (await isRecovered(35000)) await assertStable(`Transient playback API ${status === 200 ? 'empty 200' : status} automatically recovered`);
      else { findings.push(`A single playback API ${status} during seek did not recover within the existing 30-second cooldown.`); await guest.page.unroute('**/api/playback'); await manualReconnect(guest); await assertStable(`Manual reconnect after unhandled ${status}`); }
    } else {
      await guest.page.locator('.player-error').waitFor();
      const held = party.currentPosition(); await delay(2500); assert.equal(party.currentPosition(), held);
      assert.equal(requests, 1, 'A missing movie must not be retried in an automatic request loop.');
      const peers = await guest.page.evaluate(() => { window.testRetainedPeers = window.testPeers.filter(peer => peer.connectionState === 'connected'); return window.testRetainedPeers.length; });
      assert.ok(peers > 0);
      if (await guest.page.getByRole('button', { name: 'Retry movie', exact: true }).count()) {
        await guest.page.getByRole('button', { name: 'Retry movie', exact: true }).click();
        await assertStable('Explicit movie-only retry after 404');
        assert.ok(await guest.page.evaluate(() => window.testRetainedPeers.every(peer => peer.connectionState === 'connected')), 'Retry movie must keep the exact connected call peers.');
      } else { findings.push('A permanent playback API404 cannot retry only the movie while keeping its call.'); await guest.page.unroute('**/api/playback'); await manualReconnect(guest); await assertStable('Manual reconnect after unhandled 404'); }
    }
    assert.equal(faultResponses, 1, 'Exactly one response must be faulted, independent of successful retries.');
    await guest.page.unroute('**/api/playback');
  }

  // Actually reject new party WS handshakes; keep HTTP and WebRTC reachable.
  blockedCookie = (await guest.context.cookies(origin)).find(cookie => cookie.name === 'playparty_session')?.value; assert.ok(blockedCookie);
  const guestId = [...party.members.keys()].find(id => id !== 'owner');
  blockEvents = true;
  await guest.page.route('**/api/stream/**', route => route.abort('connectionrefused'));
  await guest.page.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').at(-1).close());
  await guest.page.waitForFunction(() => document.querySelector('.movie-video').paused);
  const localHeld = await guest.page.locator('.movie-video').evaluate(v => v.currentTime);
  await delay(10000);
  assert.equal(await guest.page.locator('.movie-video').evaluate(v => v.currentTime), localHeld, 'Disconnected movie must stay paused rather than run on stale state.');
  await delay(39000);
  assert.ok(rejectedHandshakes >= 10, 'Real server WS handshakes must repeatedly fail.');
  assert.ok(!party.members.has(guestId), 'The outage must outlast the actual disconnected participant TTL.');
  assert.equal(party.ready.has(guestId), false, 'Expiry must clear the former viewer’s cached readiness.');
  blockEvents = false;
  await guest.page.unroute('**/api/stream/**');
  await delay(2500);
  await guest.page.locator('#name').waitFor();
  assert.equal(await guest.page.locator('.movie-video').count(), 0, 'An expired session must remove the stale movie player.');
  assert.equal(await guest.page.evaluate(() => window.testTracks.filter(track => track.readyState === 'live').length), 0, 'Session expiry must release every native camera and microphone track.');
  assert.equal(await guest.page.locator('audio.call-audio').count(), 0, 'An expired call cannot retain audio outputs.');
  await guest.page.getByText('Your session expired. Join again to reconnect.', { exact: true }).waitFor();
  guest.expectedCaptures++;
  await join(guest);
  await assertStable('Explicit rejoin after expired session');
  console.log(`49-second party/HTTP outage: ${rejectedHandshakes} real rejected handshakes; expired session stayed paused and released devices; explicit rejoin restored current timeline.`);
  assert.deepEqual(errors, [], 'Fault handling must not produce uncaught page exceptions.');
  console.log(`Fault audit completed: ${findings.length} unhandled recovery scenarios.`);
  if (findings.length) throw Error(findings.join('\n'));
} finally {
  blockEvents = false;
  await browser?.close(); await close(); await call.deleteRoom(roomName).catch(() => {});
}
