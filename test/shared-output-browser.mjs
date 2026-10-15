// Real Plex output sharing with independent Chrome viewers and an isolated call.
// Test credentials, playback progress and the live party are never modified.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { RoomServiceClient } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const port = Number(process.env.TEST_SHARED_PORT || 5184), origin = `http://localhost:${port}`;
const roomName = `playparty-shared-output-${randomUUID()}`, ownerCookie = randomUUID();
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const originalSimplify = plex.simplify.bind(plex);
plex.simplify = item => ({ ...originalSimplify(item), resumePosition: 0 });
const call = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const clients = [], errors = [], decisions = [], ownedSessions = new Set();
const upstreamRequest = plex.request.bind(plex);
plex.request = async (target, identity, options) => {
  const url = new URL(target, plex.url);
  if (url.pathname.endsWith('/decision')) {
    const session = url.searchParams.get('session');
    decisions.push({ session, identity }); if (session) ownedSessions.add(session);
  }
  return upstreamRequest(target, identity, options);
};
const { server, party, close } = createApp({ plex, origin, roomName, recordProgress: false,
  authenticateOwner: header => cookies(header).test_owner === ownerCookie,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880',
  assetsRoot: path.resolve(process.env.TEST_BUILD_DIR || 'dist') });
let browser, phase = 'setup';
const active = () => clients.filter(client => client.active);
const rememberProducers = () => { for (const producer of plex.producers.values()) if (producer.session) ownedSessions.add(producer.session); };
const until = async (check, message, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (!(await check()) && Date.now() < deadline) await delay(100);
  assert.ok(await check(), message);
};
const instrument = () => {
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), NativeSocket = WebSocket, NativePeer = RTCPeerConnection, nativeFetch = fetch.bind(window);
  window.testTracks = []; window.testCaptures = 0; window.testSockets = []; window.testPeers = [];
  window.testPlayback = null; window.testRequest = null; window.testOffset = 0; window.testPlaying = 0;
  navigator.mediaDevices.getUserMedia = async constraints => { window.testCaptures++; const stream = await capture(constraints); window.testTracks.push(...stream.getTracks()); return stream; };
  window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.testSockets.push(this); } };
  window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.testPeers.push(this); } };
  window.fetch = async (...args) => {
    if (String(args[0]).includes('/api/playback') && typeof args[1]?.body === 'string') window.testRequest = JSON.parse(args[1].body);
    const response = await nativeFetch(...args);
    if (new URL(response.url).pathname === '/api/playback' && response.ok) {
      window.testPlayback = await response.clone().json(); window.testOffset = Number(window.testPlayback.offset) || 0;
    }
    return response;
  };
  document.addEventListener('playing', event => { if (event.target?.classList?.contains('movie-video')) window.testPlaying++; }, true);
};
const join = async client => {
  await client.page.locator('#name').fill(client.owner ? 'Shared output host' : `Shared output guest ${client.number}`);
  if (client.owner) await client.page.getByRole('switch', { name: 'I am the host' }).check();
  const response = client.page.waitForResponse(response => response.url().endsWith('/api/join') && response.request().method() === 'POST');
  await client.page.getByRole('button', { name: 'Join', exact: true }).click();
  const joined = await response; assert.equal(joined.status(), 200); client.identity = (await joined.json()).identity;
  await client.page.waitForFunction(() => window.testTracks.filter(track => track.readyState === 'live').length === 2, undefined, { timeout: 30000 });
  client.active = true;
};
const leave = async client => {
  await client.page.getByRole('button', { name: 'Leave the call', exact: true }).click();
  await client.page.locator('#name').waitFor(); client.active = false;
  assert.equal(await client.page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended')), true);
};
const reload = async client => {
  await client.page.reload(); client.expectedCaptures = 1; await join(client);
};
const post = (route, body = {}, client = clients[0]) => client.page.evaluate(async ({ route, body }) => {
  const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw Error(`Isolated playback request failed (${response.status}).`);
  return response.json();
}, { route, body });
const assignments = () => active().map(client => plex.streams.get(client.identity));
const assertShared = (count = active().length, outputs = 1) => {
  const current = assignments();
  assert.equal(current.length, count); assert.ok(current.every(Boolean), 'Every active viewer must own an assignment.');
  assert.equal(new Set(current.map(stream => stream.id)).size, outputs, 'Exact matching profiles must share one opaque output ID.');
  assert.equal(plex.producers.size, outputs, 'No unused or duplicate producer may remain.');
  rememberProducers();
};
const sample = () => {
  const video = document.querySelector('.movie-video');
  if (!video) return { present: false };
  return { present: true, time: video.currentTime + window.testOffset, at: Date.now(), paused: video.paused, ready: video.readyState,
    rate: video.playbackRate, frames: video.getVideoPlaybackQuality().totalVideoFrames, width: video.videoWidth,
    version: window.testPlayback?.mediaVersion, outputId: window.testPlayback?.outputId };
};
const assertCall = async label => {
  const others = active().length - 1;
  for (const client of active()) {
    await client.page.waitForFunction(count => document.querySelectorAll('audio.call-audio').length === count, others, { timeout: 30000 });
    const state = await client.page.evaluate(() => ({ captures: window.testCaptures,
      mic: window.testTracks.filter(track => track.kind === 'audio' && track.readyState === 'live').length,
      camera: window.testTracks.filter(track => track.kind === 'video' && track.readyState === 'live').length,
      outputs: document.querySelectorAll('audio.call-audio').length,
      peers: window.testPeers.filter(peer => peer.connectionState === 'connected').length,
      stateSockets: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length }));
    assert.equal(state.captures, client.expectedCaptures, `${label}: movie recovery cannot reacquire call devices.`);
    assert.equal(state.mic, 1); assert.equal(state.camera, 1); assert.equal(state.outputs, others); assert.ok(state.peers > 0); assert.equal(state.stateSockets, 1);
  }
};
const assertStable = async label => {
  const deadline = Date.now() + 120000;
  let healthySince = 0, samples = 0, maxDrift = 0, maxSpread = 0, firstFrames, lastFrames, held;
  while (Date.now() < deadline && (!healthySince || Date.now() - healthySince < 10000)) {
    rememberProducers();
    const before = party.snapshot(), readings = await Promise.all(active().map(client => client.page.evaluate(sample))), after = party.snapshot();
    const immutable = ['mediaVersion', 'readinessVersion', 'updatedAt', 'position', 'paused', 'waiting'].every(key => before[key] === after[key]);
    if (immutable && after.waiting) {
      assert.equal(after.paused, true);
      if (held?.version === after.readinessVersion) assert.equal(party.currentPosition(), held.position, 'A buffering shared clock must remain stationary.');
      else held = { version: after.readinessVersion, position: party.currentPosition() };
    } else held = undefined;
    const ready = immutable && !after.paused && !after.waiting && Date.now() >= after.updatedAt + 1000 && readings.every(reading => reading.present && !reading.paused && reading.ready >= 3 && reading.width > 0 && reading.version === after.mediaVersion);
    if (!ready) { healthySince = 0; samples = 0; firstFrames = undefined; }
    else {
      healthySince ||= Date.now(); samples++;
      const commonAt = Math.max(...readings.map(reading => reading.at));
      const projected = readings.map(reading => reading.time + (commonAt - reading.at) * reading.rate / 1000);
      for (const reading of readings) {
        const drift = Math.abs(reading.time - (before.position + Math.max(0, reading.at - before.updatedAt) / 1000));
        maxDrift = Math.max(maxDrift, drift); assert.ok(drift < 1, `${label}: playback must remain within one second of the shared clock.`);
      }
      const spread = Math.max(...projected) - Math.min(...projected); maxSpread = Math.max(maxSpread, spread);
      assert.ok(spread < 1, `${label}: viewer clocks must remain within one second.`);
      firstFrames ||= readings.map(reading => reading.frames); lastFrames = readings.map(reading => reading.frames);
    }
    await delay(500);
  }
  assert.ok(healthySince && Date.now() - healthySince >= 10000 && samples >= 15, `${label}: require ten continuous healthy seconds.`);
  assert.ok(lastFrames.every((frames, index) => frames > firstFrames[index]), `${label}: every browser must decode new video frames.`);
  await assertCall(label);
  console.log(JSON.stringify({ label, result: 'pass', viewers: active().length, samples, maxDrift: Number(maxDrift.toFixed(3)), maxSpread: Number(maxSpread.toFixed(3)), producers: plex.producers.size }));
};

try {
  assert.ok(plex.producers instanceof Map, 'This browser suite requires the shared-output adapter.');
  const movies = (await plex.library()).filter(item => item.type === 'movie');
  const candidates = [];
  for (const item of movies.slice(0, 30)) {
    const metadata = await plex.metadata(item.id), media = metadata.Media?.[0], movie = plex.simplify(metadata);
    if (['h264', 'avc1'].includes(media?.videoCodec) && movie.subtitles.some(track => !track.burn) && movie.duration > 180) candidates.push({ movie, bitrate: Number(media.bitrate) || Infinity });
  }
  candidates.sort((a, b) => a.bitrate - b.bitrate);
  const movie = candidates[0]?.movie;
  assert.ok(movie, 'The browser sharing test needs an existing H.264 movie with text subtitles.');
  const subtitle = movie.subtitles.find(track => !track.burn);
  await call.createRoom({ name: roomName });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  for (let number = 0; number < 5; number++) {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 960, height: 640 } });
    await context.addInitScript(instrument);
    if (!number) await context.addCookies([{ name: 'test_owner', value: ownerCookie, url: origin }]);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.name));
    const client = { number, owner: !number, page, context, active: false, expectedCaptures: 1 }; clients.push(client);
    page.on('response', response => {
      const url = new URL(response.url()), resource = plex.resources.get(url.pathname.split('/').at(-1));
      if (response.ok() && url.pathname.startsWith('/api/stream/') && resource && /\.(m4s|ts)(?:\?|$)/i.test(resource.target)) client.lastSegment = url.pathname;
    });
    await page.goto(origin); await join(client);
  }
  phase = 'concurrent matching viewers';
  const beforeDecisions = decisions.length;
  await post('select', { id: movie.id }); await assertStable('Five concurrent matching viewers'); assertShared();
  assert.equal(decisions.length - beforeDecisions, 1, 'Concurrent matching readers must create only one Plex decision/session.');
  const shared = assignments()[0];
  assert.equal(new Set(assignments().map(stream => stream.session)).size, 1);
  assert.equal(new Set(assignments().map(stream => stream.client)).size, 1, 'All requests for one producer use its stable upstream client identity.');
  const liveTranscodes = await plex.json('/transcode/sessions');
  const liveRows = liveTranscodes.TranscodeSession ? Array.isArray(liveTranscodes.TranscodeSession) ? liveTranscodes.TranscodeSession : [liveTranscodes.TranscodeSession] : [];
  const ownedRows = liveRows.filter(row => ownedSessions.has(String(row.id)) || [...ownedSessions].some(session => String(row.key || '').includes(session)));
  assert.equal(ownedRows.length, 1, 'Five matching decoded players must have exactly one actual owned Plex output session.');
  assert.ok(ownedRows.some(row => row.id === shared.session || String(row.key || '').includes(shared.session)), 'The actual Plex session must match the shared assignment.');

  phase = 'refresh and late rejoin';
  const returning = clients[4]; await leave(returning); await delay(2500);
  assert.equal(plex.producers.size, 1); assert.equal(assignments()[0].id, shared.id);
  returning.expectedCaptures++; await join(returning); await assertStable('Late rejoin uses existing output'); assertShared();
  assert.equal(assignments()[0].id, shared.id); assert.equal(plex.streams.get(returning.identity).id, shared.id);
  await reload(clients[1]); await assertStable('Guest refresh retains shared producer'); assertShared();
  assert.equal(plex.streams.get(clients[1].identity).id, shared.id);

  phase = 'personal subtitle split';
  const captioned = clients[2];
  await captioned.page.getByLabel('Subtitles', { exact: true }).selectOption(subtitle.id);
  await assertStable('Personal text subtitles create separate output'); assertShared(5, 2);
  assert.equal(await captioned.page.evaluate(() => window.testPlayback.subtitleMode), 'segmented');
  await captioned.page.waitForFunction(() => [...document.querySelector('.movie-video').textTracks].some(track => track.mode === 'showing'), undefined, { timeout: 10000 });
  assert.notEqual(plex.streams.get(captioned.identity).id, shared.id);
  assert.equal(plex.streams.get(clients[0].identity).id, shared.id);
  await captioned.page.getByLabel('Subtitles', { exact: true }).selectOption('');
  await assertStable('Returning to matching captions rejoins shared output'); assertShared();
  assert.equal(plex.streams.get(captioned.identity).id, shared.id);

  phase = 'different codec profile';
  const profile = clients[3], baselineHevc = await profile.page.evaluate(() => window.testRequest.hevc);
  const forceProfile = route => route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), hevc: !baselineHevc }) });
  await profile.page.route('**/api/playback', forceProfile);
  await reload(profile); await assertStable('Different codec profiles remain separate'); assertShared(5, 2);
  assert.notEqual(plex.streams.get(profile.identity).id, shared.id);
  await profile.page.unroute('**/api/playback', forceProfile);
  await reload(profile); await assertStable('Matching codec refresh rejoins shared output'); assertShared();

  phase = 'one response cancelled';
  const resource = plex.resources.get(clients[1].lastSegment?.split('/').at(-1));
  assert.ok(resource, 'Actual playback must expose a proxied media segment.');
  assert.equal(resource.streamId, shared.id);
  const aborted = await clients[1].page.evaluate(async url => {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body.getReader(), first = await reader.read();
    controller.abort(); await reader.cancel().catch(() => {});
    return { status: response.status, bytesRead: first.value?.byteLength || 0, totalSize: Number(response.headers.get('content-length')) || 0, aborted: controller.signal.aborted };
  }, clients[1].lastSegment);
  assert.equal(aborted.status, 200); assert.ok(aborted.bytesRead > 0); assert.equal(aborted.aborted, true);
  if (aborted.totalSize) assert.ok(aborted.bytesRead < aborted.totalSize, 'The real HTTP reader must abort before consuming the complete segment.');
  await assertStable('Cancelling one HTTP reader preserves other readers'); assertShared();
  assert.equal(assignments()[0].id, shared.id);

  phase = 'rapid host seeks';
  const firstPosition = Math.min(120, movie.duration / 5), oldIds = new Set(assignments().map(stream => stream.id));
  await post('control', { action: 'seek', position: firstPosition });
  await post('control', { action: 'seek', position: firstPosition + 15 });
  await post('control', { action: 'seek', position: firstPosition + 30 });
  await assertStable('Rapid seeks converge on one newest generation'); assertShared();
  assert.equal(assignments().every(stream => stream.version === party.mediaVersion && !oldIds.has(stream.id)), true);

  phase = 'paused idle and real producer loss';
  await post('control', { action: 'pause' });
  await Promise.all(active().map(client => client.page.waitForFunction(() => document.querySelector('.movie-video').paused)));
  const pausedAt = party.currentPosition(), idleOutput = assignments()[0];
  await delay(45000);
  assert.equal(party.currentPosition(), pausedAt, 'A long shared pause cannot advance the clock.');
  const removed = await plex.request(`/video/:/transcode/universal/stop?session=${encodeURIComponent(idleOutput.session)}`, idleOutput.client);
  await removed.arrayBuffer();
  await post('control', { action: 'play' });
  await until(() => assignments().every(stream => stream && stream.id !== idleOutput.id), 'All affected viewers must replace the expired Plex session after their existing buffers drain.', 120000);
  await assertStable('Paused shared producer loss recovers all viewers'); assertShared();
  assert.equal(assignments().every(stream => stream.id !== idleOutput.id), true, 'An expired Plex session must be replaced rather than reused indefinitely.');

  phase = 'sole viewer refresh';
  for (const client of clients.slice(1)) await leave(client);
  const soleOutput = plex.streams.get(clients[0].identity).id;
  await reload(clients[0]); await assertStable('Sole viewer refresh retains its output'); assertShared(1);
  assert.equal(plex.streams.get(clients[0].identity).id, soleOutput);

  phase = 'empty cleanup';
  await leave(clients[0]);
  assert.equal(party.movie, null); assert.equal(party.members.size, 0);
  assert.equal(plex.streams.size, 0); assert.equal(plex.producers.size, 0); assert.equal(plex.resources.size, 0);
  const transcodes = await plex.json('/transcode/sessions');
  const rows = transcodes.TranscodeSession ? Array.isArray(transcodes.TranscodeSession) ? transcodes.TranscodeSession : [transcodes.TranscodeSession] : [];
  assert.equal(rows.some(row => ownedSessions.has(String(row.id)) || [...ownedSessions].some(session => String(row.key || '').includes(session))), false, 'Only this test’s Plex sessions must all be reclaimed.');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', phase, pageErrors: errors.length, testedViewers: 5, ownedSessions: ownedSessions.size, decisionRequests: decisions.length }));
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', phase, errorType: error.name,
    message: /must|cannot|require|matching|shared|output|viewer|profile|producer|Plex|session|Isolated/i.test(error.message) ? error.message.split('\n')[0] : 'Browser operation failed',
    members: party.members.size, assignments: plex.streams.size, producers: plex.producers?.size, resources: plex.resources.size,
    paused: party.paused, waiting: party.wantsPlay, decisionRequests: decisions.length }));
  process.exitCode = 1;
} finally {
  await browser?.close(); await close(); await call.deleteRoom(roomName).catch(() => {});
}
