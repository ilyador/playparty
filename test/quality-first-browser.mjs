// Quality-first WAN sharing: staggered joins, one slow viewer and automatic recovery.
// Uses an isolated app/LiveKit room and never changes Plex playback progress.
// TEST_MOVIE selects a library fixture: normal mode needs independently decodable
// copied HLS segments; TEST_QUALITY_COMPAT=1 expects copied random access to fail.
// TEST_QUALITY_OVERLOAD=1 instead tests the actual 8Mbps shared server budget.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { RoomServiceClient } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const port = Number(process.env.TEST_QUALITY_FIRST_PORT || 5186), origin = `http://localhost:${port}`;
const roomName = `playparty-quality-first-${randomUUID()}`, ownerCookie = randomUUID();
const overload = process.env.TEST_QUALITY_OVERLOAD === '1', compatibility = process.env.TEST_QUALITY_COMPAT === '1';
assert.ok(!(overload && compatibility), 'Run aggregate congestion and decode compatibility as separate isolated cases.');
const movieMbps = overload ? 8 : 150, initialCap = Math.floor(movieMbps * 1000 * 0.85);
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const simplify = plex.simplify.bind(plex);
plex.simplify = item => ({ ...simplify(item), resumePosition: 0 });
const call = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const clients = [], errors = [], events = [], ownedSessions = new Set(), ownedClients = new Map(), ownedProfiles = new Map();
const request = plex.request.bind(plex);
plex.request = (target, identity, options) => {
  const url = new URL(target, plex.url);
  if (url.pathname.endsWith('/decision') && url.searchParams.has('session')) {
    const session = url.searchParams.get('session');
    ownedSessions.add(session); ownedClients.set(session, identity);
    ownedProfiles.set(session, { directStream: url.searchParams.get('directStream'), bitrate: Number(url.searchParams.get('maxVideoBitrate')), resolution: url.searchParams.get('videoResolution') });
  }
  return request(target, identity, options);
};
const { server, party, close } = createApp({ plex, origin, roomName, movieMbps, recordProgress: false,
  authenticateOwner: header => cookies(header).test_owner === ownerCookie,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880',
  assetsRoot: path.resolve(process.env.TEST_BUILD_DIR || 'dist'), logPlayback: event => events.push(event) });
let browser, phase = 'setup', testedViewers = 0;
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
  await client.page.locator('#name').fill(client.owner ? 'Quality host' : `Quality viewer ${clients.indexOf(client)}`);
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
    ready: video.readyState, seeking: video.seeking, buffered: [...Array(video.buffered.length)].map((_, index) => [video.buffered.start(index), video.buffered.end(index)]), error: video.error?.code, width: video.videoWidth, rate: video.playbackRate, frames: video.getVideoPlaybackQuality().totalVideoFrames,
    version: window.testPlayback?.mediaVersion, remote: window.testPlayback?.remote } : { present: false };
};
const callBytes = client => client.page.evaluate(async () => {
  const reports = await Promise.all(window.testPeers.map(peer => peer.getStats().catch(() => new Map())));
  return reports.reduce((total, report) => total + [...report.values()].filter(row => row.type === 'inbound-rtp' && row.kind === 'audio').reduce((sum, row) => sum + (row.bytesReceived || 0), 0), 0);
});
const assertStable = async label => {
  const deadline = Date.now() + 120000;
  const firstCallBytes = await Promise.all(clients.map(callBytes));
  const otherViewers = clients.length - 1;
  let healthySince = 0, samples = 0, maxDrift = 0, firstFrames, lastFrames, decodeFailedSince, lastDiagnostic = Date.now();
  while (Date.now() < deadline && (!healthySince || Date.now() - healthySince < 10000)) {
    rememberOutputs();
    const before = party.snapshot(), readings = await Promise.all(clients.map(client => client.page.evaluate(sample))), after = party.snapshot();
    const same = ['mediaVersion', 'readinessVersion', 'updatedAt', 'position', 'paused', 'waiting'].every(key => before[key] === after[key]);
    if (readings.some(reading => reading.error === 3 && reading.frames === 0)) {
      decodeFailedSince ||= Date.now();
      assert.ok(Date.now() - decodeFailedSince < 5000, `${label}: the browser decoder failed persistently before its first frame.`);
    } else decodeFailedSince = undefined;
    if (Date.now() - lastDiagnostic >= 15000) {
      lastDiagnostic = Date.now();
      console.log(JSON.stringify({ label, result: 'waiting', paused: after.paused, waiting: after.waiting, readings }));
    }
    const commonAt = Math.max(...readings.map(reading => reading.at));
    const times = readings.map(reading => reading.time + (commonAt - reading.at) * reading.rate / 1000);
    const drifts = readings.map(reading => Math.abs(reading.time - (before.position + Math.max(0, reading.at - before.updatedAt) / 1000)));
    const ready = same && !after.paused && !after.waiting && Date.now() >= after.updatedAt + 1000 &&
      readings.every(reading => reading.present && reading.remote && !reading.paused && reading.ready >= 3 && reading.width > 0 && reading.version === after.mediaVersion) &&
      drifts.every(drift => drift < 1) && Math.max(...times) - Math.min(...times) < 1;
    // Startup and seek recovery may still be converging when readyState first
    // advances. Require a full continuous synchronized window after convergence.
    if (!ready) { healthySince = 0; samples = 0; firstFrames = undefined; }
    else {
      healthySince ||= Date.now(); samples++;
      maxDrift = Math.max(maxDrift, ...drifts);
      firstFrames ||= readings.map(reading => reading.frames); lastFrames = readings.map(reading => reading.frames);
    }
    await delay(500);
  }
  assert.ok(healthySince && Date.now() - healthySince >= 10000 && samples >= 15, `${label}: require ten continuous healthy seconds.`);
  assert.ok(lastFrames.every((frames, index) => frames > firstFrames[index]), `${label}: every client must decode new movie frames.`);
  for (const [index, client] of clients.entries()) {
    await client.page.waitForFunction(count => document.querySelectorAll('audio.call-audio').length === count, otherViewers, { timeout: 30000 });
    const media = await client.page.evaluate(async () => {
      return { captures: window.testCaptures, liveInput: window.testTracks.filter(track => track.readyState === 'live').length,
        remoteAudio: [...document.querySelectorAll('audio.call-audio')].reduce((total, element) => total + (element.srcObject?.getAudioTracks().filter(track => track.readyState === 'live' && !track.muted).length || 0), 0),
        outputs: document.querySelectorAll('audio.call-audio').length,
        socket: window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).length };
    });
    assert.deepEqual(media, { captures: 1, liveInput: 2, remoteAudio: otherViewers, outputs: otherViewers, socket: 1 }, `${label}: retain the original call capture and a live remote audio output.`);
    if (otherViewers) assert.ok(await callBytes(client) > firstCallBytes[index], `${label}: every client must actually receive new call audio packets.`);
  }
  console.log(JSON.stringify({ label, result: 'pass', viewers: clients.length, samples, maxDrift: Number(maxDrift.toFixed(3)), producers: plex.producers.size }));
};

try {
  const movies = (await plex.library()).filter(item => item.type === 'movie');
  const requested = process.env.TEST_MOVIE;
  const choices = requested ? movies.filter(item => item.title === requested) : movies.slice(0, 60);
  const candidates = [];
  for (const item of choices) {
    const metadata = await plex.metadata(item.id), media = metadata.Media?.[0], bitrate = Number(media?.bitrate) || 0;
    if ((overload ? bitrate > initialCap * 1.2 : media?.videoCodec === 'h264' && bitrate > 1500 && bitrate * 3 < movieMbps * 1000 * 0.8) && Number(metadata.duration) > 1200000) candidates.push({ movie: plex.simplify(metadata), bitrate });
  }
  candidates.sort((a, b) => b.bitrate - a.bitrate);
  const movie = candidates[0]?.movie;
  assert.ok(movie, overload ? 'Choose a movie above the 6800 kbps ceiling by at least 20% and twenty minutes for genuine shared upload pressure.' : 'Choose a browser-compatible H264 movie above 1500 kbps and twenty minutes; all three original streams must fit the ample upload budget (TEST_MOVIE may select one).');
  await call.createRoom({ name: roomName });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const addViewer = async number => {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 960, height: 640 }, extraHTTPHeaders: { 'X-Forwarded-For': `198.51.100.${40 + number}` } });
    await context.addInitScript(instrument);
    if (!number) await context.addCookies([{ name: 'test_owner', value: ownerCookie, url: origin }]);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.name));
    const client = { owner: !number, context, page, mediaResponses: [], mediaFailures: [] };
    page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/stream/')) { client.mediaResponses.push(response.status()); if (client.mediaResponses.length > 30) client.mediaResponses.shift(); } });
    page.on('requestfailed', request => { if (new URL(request.url()).pathname.startsWith('/api/stream/')) { client.mediaFailures.push(request.failure()?.errorText); if (client.mediaFailures.length > 10) client.mediaFailures.shift(); } });
    clients.push(client); testedViewers = Math.max(testedViewers, clients.length); await page.goto(origin); await join(client);
    return client;
  };
  phase = 'solo remote host';
  await addViewer(0);
  await post('select', { id: movie.id });
  await post('control', { action: 'seek', position: Math.min(600, movie.duration / 3) });
  await assertStable('Remote host starts at the full configured ceiling');
  if (overload) {
    phase = 'genuine shared upload overload';
    for (let number = 1; number < 5; number++) { await addViewer(number); await delay(2000); }
    await until(() => events.some(event => event.event === 'stream-start' && event.maxBitrate < initialCap && ['bandwidth', 'stall'].includes(event.qualityReason)), 'Five movie downloads must cause observed adaptive reductions under the genuine 8Mbps shared server budget.', 180000);
    await assertStable('Five WAN viewers recover stable playback under a genuinely limited shared upload budget');
    for (const stream of assignments()) {
      assert.ok(stream, 'Every overloaded viewer must own a current assignment.');
      const matches = assignments().filter(other => other?.producer.key === stream.producer.key);
      assert.ok(matches.every(other => other.id === stream.id), 'Matching accepted quality profiles still share one Plex output.');
    }
    await until(() => !plex.pendingStarts.size && !plex.pendingRetirements.size, 'All overload quality replacements must settle.');
    await actualOutputCount(plex.producers.size);
    console.log(JSON.stringify({ label: 'Genuine shared server upload pressure', result: 'pass', viewers: clients.length, budgetMbps: movieMbps, caps: assignments().map(stream => stream.diagnostics.maxBitrate), producers: plex.producers.size }));
    phase = 'shared upload capacity restored by viewers leaving';
    while (clients.length > 1) {
      const leaving = clients.at(-1);
      await leaving.page.getByRole('button', { name: 'Leave the call', exact: true }).click();
      await leaving.page.locator('#name').waitFor();
      clients.pop();
      await until(() => !party.members.has(leaving.identity), 'Leaving must release party and stream ownership.');
    }
    await until(() => plex.streams.get(clients[0].identity)?.diagnostics.maxBitrate === initialCap, 'The remaining viewer must autonomously recover the full configured ceiling when shared capacity returns.', 360000);
    await assertStable('The remaining viewer automatically recovers full quality after other viewers leave');
    await until(() => !plex.pendingStarts.size && !plex.pendingRetirements.size, 'All restored-quality replacements must settle.');
    assert.equal(plex.producers.size, 1); await actualOutputCount(1);
  } else {
    const original = assignments()[0];
    assert.equal(original.diagnostics.maxBitrate, initialCap);
    assert.equal(original.diagnostics.videoDecision, compatibility ? 'transcode' : 'copy', compatibility ? 'An independently unplayable copied stream must recover through the decoder compatibility path.' : 'Compatible viewers must retain the original video quality.');
    if (compatibility) {
      const before = [...ownedProfiles.values()].find(profile => profile.directStream === '1');
      const after = ownedProfiles.get(original.producer.session);
      assert.ok(before, 'Try original-copy playback before forcing a compatible encode.');
      assert.deepEqual(after, { ...before, directStream: '0' }, 'Decoder compatibility must preserve the exact quality ceiling and resolution.');
    }
    await actualOutputCount(1);

    for (let number = 1; number < 3; number++) {
      phase = `staggered remote join ${number}`;
      const previousAssignments = assignments();
      await addViewer(number);
      await assertStable(`Late WAN viewer ${number} shares without reducing anyone’s quality`);
      assert.ok(assignments().every(stream => stream?.id === original.id), 'Arrival time must not change the quality group.');
      assert.ok(assignments().every(stream => stream.diagnostics.maxBitrate === initialCap), 'Every healthy WAN viewer retains the same full quality ceiling.');
      if (compatibility) assert.ok(assignments().every(stream => ownedProfiles.get(stream.producer.session)?.directStream === '0'), 'Matching decoder compatibility profiles must share one full-quality encoded output.');
      previousAssignments.forEach((stream, index) => assert.equal(assignments()[index], stream, 'Joining viewers cannot restart an existing assignment.'));
      assert.equal(plex.producers.size, 1); await actualOutputCount(1);
    }

    phase = 'one independently constrained WAN link';
    const slow = clients[2], healthyAssignments = assignments().slice(0, 2);
    const network = await slow.context.newCDPSession(slow.page);
    await network.send('Network.enable');
    // Original VBR can be much lower than its quality ceiling. This link is deliberately
    // insufficient, so the normal player must detect pressure itself.
    await network.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 250000, uploadThroughput: 1000000 });
    const reduced = () => {
      const stream = plex.streams.get(slow.identity);
      return stream && stream.id !== original.id && stream.diagnostics.maxBitrate < initialCap && stream.diagnostics.videoDecision === 'transcode' &&
        events.some(event => event.event === 'stream-start' && event.viewer === slow.identity && event.maxBitrate < initialCap && ['bandwidth', 'stall'].includes(event.qualityReason));
    };
    await until(reduced, 'The slow guest must autonomously receive a separate lower-quality video transcode.', 180000);
    await assertStable('The constrained guest plays stably at 2Mbps and 150ms while healthy viewers retain full quality');
    healthyAssignments.forEach((stream, index) => assert.equal(plex.streams.get(clients[index].identity), stream, 'The two healthy viewers must retain their original quality and assignments.'));
    await until(() => !plex.pendingStarts.size && !plex.pendingRetirements.size, 'Constrained quality replacements must settle before counting actual Plex outputs.');
    const reducedStream = plex.streams.get(slow.identity);
    assert.notEqual(reducedStream.id, original.id);
    assert.equal(reducedStream.diagnostics.videoDecision, 'transcode');
    assert.ok(reducedStream.diagnostics.maxBitrate < initialCap);
    assert.equal(plex.producers.size, 2); await actualOutputCount(2);
    console.log(JSON.stringify({ label: 'Only the constrained guest reduces quality', result: 'pass', initialCap, reducedCap: reducedStream.diagnostics.maxBitrate, producers: plex.producers.size }));

    phase = 'automatic full-quality recovery';
    await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await until(() => {
      healthyAssignments.forEach((stream, index) => assert.equal(plex.streams.get(clients[index].identity), stream, 'A recovering guest cannot lower or restart healthy viewers.'));
      const stream = plex.streams.get(slow.identity);
      return stream?.id === original.id && stream.diagnostics.maxBitrate === initialCap;
    }, 'Restored bandwidth must automatically recover full quality and merge into the original output, without refresh or manual quality requests.', 360000);
    assert.ok(events.some(event => event.event === 'stream-start' && event.viewer === slow.identity && event.qualityReason === 'recovery' && event.maxBitrate === initialCap), 'Recovery must come from the normal adaptive controller.');
    await assertStable('Restored guest automatically rejoins full quality while all players stay synchronized');
    assert.equal(plex.producers.size, 1); await actualOutputCount(1);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', phase, pageErrors: errors.length, testedViewers }));
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', phase, errorType: error.name,
    message: error.message.split('\n')[0], members: party.members.size, assignments: plex.streams.size, producers: plex.producers.size,
    readings: await Promise.all(clients.map(client => client.page.evaluate(sample).catch(() => ({ unavailable: true })))),
    media: clients.map(client => ({ responses: client.mediaResponses, failures: client.mediaFailures })),
    recent: events.slice(-20).map(event => ({ event: event.event, readyState: event.readyState, status: event.status, qualityReason: event.qualityReason, maxBitrate: event.maxBitrate, paused: event.paused, waiting: event.waiting })),
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
