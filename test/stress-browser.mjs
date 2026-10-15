// Real Plex/LiveKit playback under network pressure and repeated client churn.
// Uses one Chrome process, four isolated contexts, and never saves Plex progress.
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
const roomName = `playparty-stress-test-${randomUUID()}`;
const ownerCookie = randomUUID();
const events = [], errors = [], clients = [];
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const call = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const { server, party, close } = createApp({ plex,
  authenticateOwner: header => cookies(header).test_owner === ownerCookie,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880',
  origin, roomName, recordProgress: false,
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined,
  logPlayback: sample => events.push(sample),
});
let browser, releaseDelayed;
const instrument = () => {
  const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), NativePeer = RTCPeerConnection;
  window.testCaptures = []; window.testTracks = []; window.testPeers = []; window.testPlaybackReports = [];
  navigator.mediaDevices.getUserMedia = async constraints => {
    window.testCaptures.push(constraints);
    const stream = await nativeCapture(constraints); window.testTracks.push(...stream.getTracks()); return stream;
  };
  window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.testPeers.push(this); } };
  const NativeSocket = WebSocket;
  window.testSockets = [];
  window.WebSocket = class extends NativeSocket {
    constructor(...args) { super(...args); window.testSockets.push(this); }
    send(data) {
      if (typeof data === 'string') { try { const sample = JSON.parse(data); if (sample.type === 'telemetry') window.testPlaybackReports.push(sample); } catch {} }
      return super.send(data);
    }
  };
};
const playing = () => { const v = document.querySelector('.movie-video'); return v && !v.paused && v.readyState >= 3 && v.currentTime > 2; };
const attachPage = async client => {
  client.page = await client.context.newPage();
  client.page.on('pageerror', error => errors.push(error.message));
  if (client.remote) {
    client.network = await client.context.newCDPSession(client.page);
    client.streams = [];
    client.page.on('response', async response => {
      if (response.url().endsWith('/api/playback') && response.ok()) client.streams.push(await response.json().catch(() => ({})));
    });
  }
  await client.page.goto(origin);
};
const join = async client => {
  await client.page.locator('#name').fill(client.label);
  if (client.owner) await client.page.getByRole('switch', { name: 'I am the host' }).check();
  await client.page.getByRole('button', { name: 'Join', exact: true }).click();
  await client.page.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor({ timeout: 30000 });
  await client.page.waitForFunction(() => window.testTracks.filter(track => track.readyState === 'live').length === 2);
  client.active = true;
};
const active = () => clients.filter(client => client.active);
const post = (action, body = {}) => clients[0].page.evaluate(async ({ action, body }) => {
  const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}, { action, body });
const waitPlaying = async () => {
  await Promise.all(active().map(client => client.page.waitForFunction(playing, undefined, { timeout: 90000 })));
  const deadline = Date.now() + 15000;
  while ((party.paused || party.wantsPlay || Date.now() < party.updatedAt) && Date.now() < deadline) await delay(100);
  assert.ok(!party.paused && !party.wantsPlay, 'All connected clients must settle on a playing shared timeline.');
};
const assertCall = async label => {
  const outputCount = active().length - 1;
  await Promise.all(active().map(client => client.page.waitForFunction(count => document.querySelectorAll('audio.call-audio').length === count, outputCount, { timeout: 30000 })));
  for (const client of active()) {
    const result = await client.page.evaluate(() => ({
      captures: window.testCaptures.length,
      microphone: window.testTracks.filter(track => track.kind === 'audio' && track.readyState === 'live').length,
      camera: window.testTracks.filter(track => track.kind === 'video' && track.readyState === 'live').length,
      outputs: document.querySelectorAll('audio.call-audio').length,
      connected: window.testPeers.filter(peer => peer.connectionState === 'connected').length,
    }));
    assert.equal(result.captures, client.expectedCaptures, `${label}: ${client.label} must not acquire another microphone/camera for playback recovery.`);
    assert.equal(result.microphone, 1); assert.equal(result.camera, 1);
    assert.equal(result.outputs, outputCount, `${label}: one call audio output per other client.`);
    assert.ok(result.connected > 0, `${label}: the call must remain connected.`);
  }
};
// Ten seconds of repeated measurements, rather than a single convenient frame.
// A genuine buffer hold is allowed, but its clock must remain stationary.
const assertStable = async label => {
  await waitPlaying();
  await delay(1500);
  const deadline = Date.now() + 90000;
  let stableSince = Date.now(), samples = 0, holds = 0, heldPosition, heldVersion, maxDrift = 0, maxSpread = 0;
  while (Date.now() < deadline && Date.now() - stableSince < 10000) {
    const state = party.snapshot();
    if (state.waiting) {
      assert.equal(state.paused, true, `${label}: buffering must pause the shared clock.`);
      if (heldPosition !== undefined && heldVersion === state.readinessVersion) assert.equal(party.currentPosition(), heldPosition, `${label}: the buffering clock must not advance.`);
      else { heldPosition = party.currentPosition(); heldVersion = state.readinessVersion; holds++; }
      stableSince = Date.now();
    } else {
      heldPosition = undefined;
      assert.equal(state.paused, false, `${label}: playback must not spontaneously become intentionally paused.`);
      const readings = await Promise.all(active().map(client => client.page.evaluate(() => {
        const v = document.querySelector('.movie-video');
        return { time: v.currentTime, at: Date.now(), paused: v.paused, ready: v.readyState, rate: v.playbackRate };
      })));
      // Do not mix an old clock with frames read across a hold/resume or seek.
      const after = party.snapshot();
      const sameClock = ['mediaVersion', 'readinessVersion', 'updatedAt', 'position'].every(key => state[key] === after[key]);
      if (sameClock && !after.waiting && !after.paused && Date.now() >= after.updatedAt + 1000) {
        const commonAt = Math.max(...readings.map(reading => reading.at));
        const projected = readings.map(reading => reading.time + (reading.paused ? 0 : (commonAt - reading.at) * reading.rate / 1000));
        for (const reading of readings) {
          const target = state.position + Math.max(0, reading.at - state.updatedAt) / 1000;
          const drift = Math.abs(reading.time - target); maxDrift = Math.max(maxDrift, drift);
          assert.ok(!reading.paused && reading.ready >= 3, `${label}: a settled client must actually play decoded movie frames.`);
          assert.ok(drift < 1, `${label}: shared-timeline drift must stay below one second (${drift.toFixed(3)}s).`);
        }
        const spread = Math.max(...projected) - Math.min(...projected); maxSpread = Math.max(maxSpread, spread);
        assert.ok(spread < 1, `${label}: client-to-client spread must stay below one second (${spread.toFixed(3)}s).`);
        samples++;
      } else stableSince = Date.now();
    }
    await delay(500);
  }
  assert.ok(Date.now() - stableSince >= 10000 && samples >= 15, `${label}: obtain ten continuous stable seconds, not an isolated good sample.`);
  await assertCall(label);
  console.log(`${label}: ${samples} repeated samples over 10 stable seconds; max drift ${maxDrift.toFixed(3)}s; max client spread ${maxSpread.toFixed(3)}s; ${holds} synchronized buffer holds.`);
};
try {
  await call.createRoom({ name: roomName });
  await new Promise(resolve => server.listen(5177, '127.0.0.1', resolve));
  const library = (await plex.library()).filter(item => item.type === 'movie');
  const item = library.find(item => item.title === process.env.TEST_MOVIE) || library[0];
  assert.ok(item, 'The Plex library must contain a movie.');
  const movie = plex.simplify(await plex.metadata(item.id));
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  for (let index = 0; index < 4; index++) {
    const client = { label: index ? `Test Guest ${index}` : 'Test Host', owner: index === 0, remote: index === 3, expectedCaptures: 1, active: false };
    client.context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 960, height: 640 },
      ...(client.remote ? { extraHTTPHeaders: { 'X-Forwarded-For': '198.51.100.10' } } : {}) });
    await client.context.addInitScript(instrument);
    if (client.owner) await client.context.addCookies([{ name: 'test_owner', value: ownerCookie, url: origin }]);
    clients.push(client); await attachPage(client); await join(client);
  }
  await post('select', { id: movie.id });
  await waitPlaying();
  const start = Math.min(600, Math.max(10, movie.duration / 3));
  await post('control', { action: 'seek', position: start });
  await assertStable('Four-client baseline');

  const remote = clients[3];
  await remote.network.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 1000000 });
  let sawDelayed;
  const delayed = new Promise(resolve => { sawDelayed = resolve; });
  const released = new Promise(resolve => { releaseDelayed = resolve; });
  let delayedOnce = false;
  await remote.page.route('**/api/playback', async route => {
    if (!delayedOnce) { delayedOnce = true; sawDelayed(); await released; }
    await route.continue().catch(error => { if (!remote.page.isClosed() && !/already handled/i.test(error.message)) throw error; });
  });
  await post('control', { action: 'seek', position: start + 30 });
  await Promise.race([delayed, delay(15000).then(() => { throw Error('The remote cold stream must request playback.'); })]);
  assert.ok(party.paused && party.wantsPlay, 'A cold slow stream must hold all connected movie timelines.');
  const heldPosition = party.currentPosition();
  await delay(2500);
  assert.equal(party.currentPosition(), heldPosition, 'The shared movie clock cannot run ahead during a slow cold stream.');
  await assertCall('Cold remote stream hold');
  releaseDelayed();
  await waitPlaying();
  await remote.page.unroute('**/api/playback');
  const qualityDeadline = Date.now() + 60000;
  while (!remote.streams.some(stream => stream.remote && stream.currentBitrate < stream.maxBitrate) && Date.now() < qualityDeadline) await delay(250);
  assert.ok(remote.streams.some(stream => stream.remote && stream.currentBitrate < stream.maxBitrate), 'A bandwidth-constrained remote client must lower only its own Plex stream cap.');
  assert.ok(events.some(event => event.event === 'stream-start' && event.viewer === 'owner' && !event.remote && event.maxBitrate === 0), 'The local host must keep unrestricted Plex quality.');
  await assertStable('150ms latency / 1.6Mbps remote download');
  await remote.network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  for (const client of [clients[1], clients[0]]) {
    await client.page.reload(); client.expectedCaptures = 1;
    await client.page.locator('#name').waitFor(); await join(client);
    await assertStable(client.owner ? 'Host refresh during playback' : 'Guest refresh during playback');
  }
  const churn = clients[2];
  for (let cycle = 1; cycle <= 3; cycle++) {
    await churn.page.getByRole('button', { name: 'Leave the call', exact: true }).click(); churn.active = false;
    await churn.page.locator('#name').waitFor();
    assert.ok(await churn.page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended')), 'Leaving releases every native device track.');
    await assertStable(`Churn ${cycle}: guest absent`);
    churn.expectedCaptures++; await join(churn);
    await assertStable(`Churn ${cycle}: guest rejoined`);
  }
  // No Leave request: a disappearing tab must not strand the other clients.
  const abrupt = clients[1];
  await abrupt.page.close(); abrupt.active = false;
  await assertStable('Abrupt guest tab closure');
  await attachPage(abrupt); abrupt.expectedCaptures = 1; await join(abrupt);
  await assertStable('Abruptly disconnected guest returns');
  assert.ok(events.some(event => event.event === 'shared-buffering' || event.event === 'join-wait'));
  const callReports = events.filter(event => event.event === 'call-audio-output');
  assert.ok(callReports.length > 0);
  assert.ok(callReports.every(event => event.callAudioDuplicates === 0 && event.callAudioUnexpected === 0), 'No churn or playback recovery may duplicate call output.');
  assert.deepEqual(errors, []);
  console.log('Stress passed: four real clients, constrained remote playback, stationary cold-stream clock, host/guest refresh, three leave/rejoin cycles, abrupt tab loss/return, and retained call capture/output ownership.');
} finally {
  releaseDelayed?.();
  await browser?.close();
  await close();
  await call.deleteRoom(roomName).catch(() => {});
}
