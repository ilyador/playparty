// Two WAN viewers sharing a real Plex transcode, with one independent slow link.
// Uses an isolated app/LiveKit room and never changes Plex playback progress.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { RoomServiceClient } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const port = Number(process.env.TEST_SHARED_REMOTE_PORT || 5185), origin = `http://localhost:${port}`;
const roomName = `playparty-shared-remote-${randomUUID()}`, ownerCookie = randomUUID();
const movieMbps = 8, initialCap = Math.floor(movieMbps * 1000 * 0.85 / 2);
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const simplify = plex.simplify.bind(plex);
plex.simplify = item => ({ ...simplify(item), resumePosition: 0 });
const call = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const clients = [], errors = [], events = [], ownedSessions = new Set(), ownedClients = new Map();
const request = plex.request.bind(plex);
plex.request = (target, identity, options) => {
  const url = new URL(target, plex.url);
  if (url.pathname.endsWith('/decision') && url.searchParams.has('session')) {
    const session = url.searchParams.get('session');
    ownedSessions.add(session); ownedClients.set(session, identity);
  }
  return request(target, identity, options);
};
const { server, party, close } = createApp({ plex, origin, roomName, movieMbps, recordProgress: false,
  authenticateOwner: header => cookies(header).test_owner === ownerCookie,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880',
  assetsRoot: path.resolve(process.env.TEST_BUILD_DIR || 'dist'), logPlayback: event => events.push(event) });
let browser, phase = 'setup';
const rememberOutputs = () => { for (const producer of plex.producers.values()) { ownedSessions.add(producer.session); ownedClients.set(producer.session, producer.client); } };
const until = async (check, message, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  while (!(await check()) && Date.now() < deadline) { rememberOutputs(); await delay(250); }
  assert.ok(await check(), message);
};
const instrument = () => {
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), nativeFetch = fetch.bind(window), NativeSocket = WebSocket, NativePeer = RTCPeerConnection;
  window.testCaptures = 0; window.testTracks = []; window.testPlayback = null; window.testSockets = []; window.testPeers = [];
  navigator.mediaDevices.getUserMedia = async constraints => { window.testCaptures++; const stream = await capture(constraints); window.testTracks.push(...stream.getTracks()); return stream; };
  window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.testSockets.push(this); } };
  window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.testPeers.push(this); } };
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (new URL(response.url).pathname === '/api/playback' && response.ok) window.testPlayback = await response.clone().json();
    return response;
  };
};
const join = async client => {
  await client.page.locator('#name').fill(client.owner ? 'Remote host' : 'Remote viewer');
  if (client.owner) await client.page.getByRole('switch', { name: 'I am the host' }).check();
  const joined = client.page.waitForResponse(response => response.url().endsWith('/api/join') && response.request().method() === 'POST');
  await client.page.getByRole('button', { name: 'Join', exact: true }).click();
  const response = await joined; assert.equal(response.status(), 200); client.identity = (await response.json()).identity;
  await client.page.waitForFunction(() => window.testTracks.filter(track => track.readyState === 'live').length === 2, undefined, { timeout: 30000 });
  await until(() => party.members.get(client.identity)?.connected, 'The remote client must connect to the actual party socket.', 30000);
};
const post = (route, body = {}) => clients[0].page.evaluate(async ({ route, body }) => {
  const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw Error(`The isolated remote ${route} request failed (${response.status}).`);
  return response.json();
}, { route, body });
const assignments = () => clients.map(client => plex.streams.get(client.identity));
const actualOutputCount = async expected => {
  rememberOutputs();
  const data = await plex.json('/transcode/sessions');
  const rows = data.TranscodeSession ? Array.isArray(data.TranscodeSession) ? data.TranscodeSession : [data.TranscodeSession] : [];
  const owned = rows.filter(row => ownedSessions.has(String(row.id)) || [...ownedSessions].some(session => String(row.key || '').includes(session)));
  assert.equal(owned.length, expected, 'Plex itself must report the expected number of this test’s output sessions.');
  for (const output of new Set(assignments().filter(Boolean).map(stream => stream.producer))) {
    assert.ok(owned.some(row => row.id === output.session || String(row.key || '').includes(output.session)), 'Every active producer must exist in Plex.');
  }
};
const sample = () => {
  const video = document.querySelector('.movie-video');
  return video ? { present: true, time: video.currentTime + (window.testPlayback?.offset || 0), at: Date.now(), paused: video.paused,
    ready: video.readyState, width: video.videoWidth, rate: video.playbackRate, frames: video.getVideoPlaybackQuality().totalVideoFrames,
    version: window.testPlayback?.mediaVersion, remote: window.testPlayback?.remote } : { present: false };
};
const callBytes = client => client.page.evaluate(async () => {
  const reports = await Promise.all(window.testPeers.map(peer => peer.getStats().catch(() => new Map())));
  return reports.reduce((total, report) => total + [...report.values()].filter(row => row.type === 'inbound-rtp' && row.kind === 'audio').reduce((sum, row) => sum + (row.bytesReceived || 0), 0), 0);
});
const assertStable = async label => {
  const deadline = Date.now() + 120000;
  const firstCallBytes = await Promise.all(clients.map(callBytes));
  let healthySince = 0, samples = 0, maxDrift = 0, firstFrames, lastFrames;
  while (Date.now() < deadline && (!healthySince || Date.now() - healthySince < 10000)) {
    rememberOutputs();
    const before = party.snapshot(), readings = await Promise.all(clients.map(client => client.page.evaluate(sample))), after = party.snapshot();
    const same = ['mediaVersion', 'readinessVersion', 'updatedAt', 'position', 'paused', 'waiting'].every(key => before[key] === after[key]);
    const ready = same && !after.paused && !after.waiting && Date.now() >= after.updatedAt + 1000 && readings.every(reading => reading.present && reading.remote && !reading.paused && reading.ready >= 3 && reading.width > 0 && reading.version === after.mediaVersion);
    if (!ready) { healthySince = 0; samples = 0; firstFrames = undefined; }
    else {
      healthySince ||= Date.now(); samples++;
      const commonAt = Math.max(...readings.map(reading => reading.at));
      const times = readings.map(reading => reading.time + (commonAt - reading.at) * reading.rate / 1000);
      for (const reading of readings) {
        const drift = Math.abs(reading.time - (before.position + Math.max(0, reading.at - before.updatedAt) / 1000));
        maxDrift = Math.max(maxDrift, drift); assert.ok(drift < 1, `${label}: each remote player must remain within one second of the party clock.`);
      }
      assert.ok(Math.max(...times) - Math.min(...times) < 1, `${label}: remote players must remain within one second of each other.`);
      firstFrames ||= readings.map(reading => reading.frames); lastFrames = readings.map(reading => reading.frames);
    }
    await delay(500);
  }
  assert.ok(healthySince && Date.now() - healthySince >= 10000 && samples >= 15, `${label}: require ten continuous healthy seconds.`);
  assert.ok(lastFrames.every((frames, index) => frames > firstFrames[index]), `${label}: both clients must decode new movie frames.`);
  for (const [index, client] of clients.entries()) {
    await client.page.waitForFunction(() => document.querySelectorAll('audio.call-audio').length === 1, undefined, { timeout: 30000 });
    const media = await client.page.evaluate(async () => {
      const audio = document.querySelector('audio.call-audio');
      const stream = audio?.srcObject;
      return { captures: window.testCaptures, liveInput: window.testTracks.filter(track => track.readyState === 'live').length,
        remoteAudio: stream?.getAudioTracks().filter(track => track.readyState === 'live' && !track.muted).length || 0,
        outputs: document.querySelectorAll('audio.call-audio').length,
        socket: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length };
    });
    assert.deepEqual(media, { captures: 1, liveInput: 2, remoteAudio: 1, outputs: 1, socket: 1 }, `${label}: retain the original call capture and a live remote audio output.`);
    assert.ok(await callBytes(client) > firstCallBytes[index], `${label}: both clients must actually receive new call audio packets.`);
  }
  console.log(JSON.stringify({ label, result: 'pass', viewers: 2, samples, maxDrift: Number(maxDrift.toFixed(3)), producers: plex.producers.size }));
};

try {
  const movies = (await plex.library()).filter(item => item.type === 'movie');
  const requested = process.env.TEST_MOVIE;
  const choices = requested ? movies.filter(item => item.title === requested) : movies.slice(0, 60);
  const candidates = [];
  for (const item of choices) {
    const metadata = await plex.metadata(item.id), bitrate = Number(metadata.Media?.[0]?.bitrate) || 0;
    if (bitrate >= initialCap * 1.5 && Number(metadata.duration) > 240000) candidates.push({ movie: plex.simplify(metadata), bitrate });
  }
  candidates.sort((a, b) => b.bitrate - a.bitrate);
  const movie = candidates[0]?.movie;
  assert.ok(movie, 'Choose an existing movie above 5100 kbps and four minutes (TEST_MOVIE may select one).');
  await call.createRoom({ name: roomName });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  for (let number = 0; number < 2; number++) {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 960, height: 640 }, extraHTTPHeaders: { 'X-Forwarded-For': `198.51.100.${20 + number}` } });
    await context.addInitScript(instrument);
    if (!number) await context.addCookies([{ name: 'test_owner', value: ownerCookie, url: origin }]);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.name));
    const client = { owner: !number, context, page }; clients.push(client); await page.goto(origin); await join(client);
  }
  phase = 'matching WAN transcode';
  await post('select', { id: movie.id });
  await post('control', { action: 'seek', position: Math.min(600, movie.duration / 3) });
  await assertStable('Two WAN clients share a transcoded output');
  assert.equal(assignments().every(Boolean), true);
  const original = assignments()[0];
  assert.equal(assignments()[1].id, original.id); assert.equal(plex.producers.size, 1);
  assert.equal(original.diagnostics.videoDecision, 'transcode', 'The WAN test must exercise video conversion, not an original-quality copy.');
  await actualOutputCount(1);

  phase = 'one WAN link constrained';
  const slow = clients[1], network = await slow.context.newCDPSession(slow.page);
  await network.send('Network.enable');
  // Encoder caps are not actual VBR rates. First force a brief severe movie
  // bottleneck, then give the lower rendition enough bandwidth to recover.
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 64000, uploadThroughput: 1000000 });
  await until(() => {
    const output = plex.streams.get(slow.identity);
    return output && output.id !== original.id && events.some(event => event.event === 'stream-start' && event.viewer === slow.identity && event.maxBitrate < initialCap && ['bandwidth', 'stall'].includes(event.qualityReason));
  }, 'The slow WAN client must adapt by itself into a distinct lower-quality output.');
  assert.equal(plex.streams.get(clients[0].identity), original, 'The healthy WAN client must retain the shared output.');
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 250000, uploadThroughput: 1000000 });
  await assertStable('Only the slow WAN viewer reduces quality');
  assert.equal(plex.streams.get(clients[0].identity), original);
  assert.equal(plex.producers.size, 2); await actualOutputCount(2);

  phase = 'WAN restored';
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await assertStable('Both WAN viewers remain synchronized after network restoration');
  phase = 'matching WAN refresh';
  await slow.page.reload(); await join(slow);
  await assertStable('A refreshed WAN viewer rejoins the existing matching output');
  assert.equal(plex.streams.get(slow.identity).id, original.id, 'A normal refreshed WAN player with the same peers must rejoin the original profile.');
  assert.equal(plex.producers.size, 1); await actualOutputCount(1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', phase, pageErrors: errors.length, testedViewers: 2 }));
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', phase, errorType: error.name,
    message: error.message.split('\n')[0], members: party.members.size, assignments: plex.streams.size, producers: plex.producers.size,
    profiles: clients.map(client => ({ maxBitrate: plex.streams.get(client.identity)?.diagnostics?.maxBitrate,
      latestStart: events.filter(event => event.event === 'stream-start' && event.viewer === client.identity).map(event => ({ bitrate: event.maxBitrate, reason: event.qualityReason })).at(-1) })) }));
  process.exitCode = 1;
} finally {
  await browser?.close(); await close(); await call.deleteRoom(roomName).catch(() => {});
  // The set includes starts superseded before they became current assignments.
  await Promise.all([...ownedSessions].map(async session => {
    const response = await plex.request(`/video/:/transcode/universal/stop?session=${encodeURIComponent(session)}`, ownedClients.get(session)).catch(() => undefined);
    await response?.arrayBuffer();
  }));
  await actualOutputCount(0);
}
