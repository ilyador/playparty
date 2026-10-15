// Actual OS-level guest call-network interruption, real LiveKit RTP counters,
// isolated browsers/room, and no Plex progress writes or host firewall changes.
// SIGSTOP affects ONLY the NetworkService descendant of this test's own Chrome.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const port = 5180, origin = `http://localhost:${port}`;
const roomName = `playparty-rtc-link-${randomUUID()}`, ownerCookie = randomUUID();
const errors = [], clients = [];
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const call = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const { server, party, close } = createApp({ plex, authenticateOwner: header => cookies(header).test_owner === ownerCookie,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', origin, roomName, recordProgress: false,
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined });
let hostBrowser, guestBrowser, guestChrome, guestChromeExit, profile, session, networkPid, networkStopped = false;
const instrument = () => {
  const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), NativePeer = RTCPeerConnection, NativeSocket = WebSocket;
  window.testCaptures = []; window.testTracks = []; window.testPeers = []; window.testSockets = []; window.testTasks = 0;
  window.testPeerEvents = []; window.testIceRestarts = [];
  window.testPongs = [];
  setInterval(() => window.testTasks++, 250);
  navigator.mediaDevices.getUserMedia = async constraints => { window.testCaptures.push(constraints); const stream = await nativeCapture(constraints); window.testTracks.push(...stream.getTracks()); return stream; };
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args); const index = window.testPeers.length; window.testPeers.push(this);
      for (const type of ['connectionstatechange', 'iceconnectionstatechange']) this.addEventListener(type, () => window.testPeerEvents.push({ index, type, at: Date.now(), state: this.connectionState, ice: this.iceConnectionState }));
    }
    createOffer(options) { if (options?.iceRestart) window.testIceRestarts.push({ at: Date.now() }); return super.createOffer(options); }
  };
  window.WebSocket = class extends NativeSocket {
    constructor(...args) { super(...args); window.testSockets.push(this); }
    get onmessage() { return this.testHandler; }
    set onmessage(handler) {
      this.testHandler = handler;
      super.onmessage = event => {
        try { const message = JSON.parse(event.data); if (message.type === 'pong') window.testPongs.push({ sent: message.sent, received: Date.now(), rtt: Date.now() - message.sent, offset: message.serverTime - (Date.now() + message.sent) / 2 }); } catch {}
        handler?.call(this, event);
      };
    }
  };
};
const join = async client => {
  await client.page.locator('#name').fill(client.host ? 'Link Host' : 'Link Guest');
  if (client.host) await client.page.getByRole('switch', { name: 'I am the host' }).check();
  await client.page.getByRole('button', { name: 'Join', exact: true }).click();
  await client.page.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor({ timeout: 30000 });
};
const parentPid = async pid => {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
};
const ownsNetworkProcess = async pid => {
  try {
    // Chrome flattens its proc command line on this build; tokenise both normal
    // NUL-separated argv and its space-separated process title.
    const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ').trim().split(/\s+/);
    if (!command.some(arg => arg === '--utility-sub-type=network.mojom.NetworkService')) return false;
    // Utility children do not repeat user-data-dir on every Chrome build. Its
    // owned browser ancestor must still have this exact private test profile.
    const rootCommand = (await readFile(`/proc/${guestChrome.pid}/cmdline`, 'utf8')).replaceAll('\0', ' ').trim().split(/\s+/);
    if (!rootCommand.includes(`--user-data-dir=${profile}`)) return false;
    let ancestor = pid;
    for (let depth = 0; depth < 8; depth++) { ancestor = await parentPid(ancestor); if (ancestor === guestChrome.pid) return true; if (ancestor < 2) break; }
  } catch {}
  return false;
};
const findNetworkProcess = async () => {
  for (const entry of await readdir('/proc')) if (/^\d+$/.test(entry) && await ownsNetworkProcess(Number(entry))) return Number(entry);
  throw Error('The owned guest Chrome must have its own verifiable NetworkService child.');
};
const cutNetwork = async () => {
  networkPid = await findNetworkProcess();
  assert.ok(await ownsNetworkProcess(networkPid), 'Only an owned isolated Chrome descendant may be stopped.');
  process.kill(networkPid, 'SIGSTOP'); networkStopped = true;
  const status = await readFile(`/proc/${networkPid}/status`, 'utf8');
  assert.match(status, /State:\s+T/, 'The owned network utility must actually be stopped.');
};
const restoreNetwork = async () => {
  if (!networkStopped) return;
  assert.ok(await ownsNetworkProcess(networkPid), 'The same owned NetworkService must still exist before resuming it.');
  process.kill(networkPid, 'SIGCONT'); networkStopped = false;
};
const stats = page => page.evaluate(async () => {
  const result = { bytes: 0, packets: 0, videoFrames: 0, audioBytes: 0, audioPackets: 0, peers: [], candidates: [], captures: window.testCaptures.length,
    outputs: document.querySelectorAll('audio.call-audio').length, audioLive: window.testTracks.filter(t => t.kind === 'audio' && t.readyState === 'live').length,
    videoLive: window.testTracks.filter(t => t.kind === 'video' && t.readyState === 'live').length,
    micEnabled: window.testTracks.filter(t => t.kind === 'audio' && t.readyState === 'live').some(t => t.enabled),
    stateSockets: window.testSockets.filter(s => new URL(s.url).pathname === '/events' && s.readyState === WebSocket.OPEN).length };
  for (const peer of window.testPeers) {
    result.peers.push({ state: peer.connectionState, ice: peer.iceConnectionState });
    const values = await peer.getStats();
    for (const value of values.values()) {
      if (value.type === 'inbound-rtp') {
        result.bytes += value.bytesReceived || 0; result.packets += value.packetsReceived || 0; result.videoFrames += value.framesDecoded || 0;
        if (value.kind === 'audio') { result.audioBytes += value.bytesReceived || 0; result.audioPackets += value.packetsReceived || 0; }
      }
      if (value.type === 'candidate-pair' && value.nominated) {
        const local = values.get(value.localCandidateId), remote = values.get(value.remoteCandidateId);
        result.candidates.push({ state: value.state, protocol: local?.protocol, localPort: local?.port, remotePort: remote?.port, remoteType: remote?.candidateType, localType: local?.candidateType });
      }
    }
  }
  return result;
});
const health = async (label, muted = false) => {
  for (const client of clients) {
    const state = await stats(client.page);
    assert.equal(state.captures, 1, `${label}: reconnect cannot reacquire microphone/camera.`);
    assert.equal(state.audioLive, 1); assert.equal(state.videoLive, 1); assert.equal(state.outputs, 1);
    assert.equal(state.stateSockets, 1); assert.ok(state.peers.some(peer => peer.state === 'connected'));
    assert.equal(state.micEnabled, client.host || !muted, `${label}: user's mute choice must remain unchanged.`);
    assert.ok(state.candidates.some(pair => pair.protocol === 'udp' && pair.state === 'succeeded'), `${label}: call must use a real selected UDP ICE candidate pair.`);
    if (!client.host && muted) assert.equal(await client.page.getByRole('button', { name: 'Turn on microphone', exact: true }).count(), 1, `${label}: UI must retain the muted microphone state.`);
  }
  const participants = await call.listParticipants(roomName);
  assert.equal(participants.length, 2);
  for (const participant of participants) {
    assert.equal(participant.tracks.length, 2, `${label}: exactly one microphone and camera publication.`);
    assert.ok(participant.tracks.some(track => track.source === TrackSource.CAMERA && !track.muted));
    assert.ok(participant.tracks.some(track => track.source === TrackSource.MICROPHONE && track.muted === (participant.identity !== 'owner' && muted)), `${label}: LiveKit microphone publication must preserve the user's mute choice.`);
  }
  // A muted local microphone must still receive real remote audio and video.
  const before = await stats(clients[1].page); await delay(1000); const after = await stats(clients[1].page);
  assert.ok(after.audioPackets > before.audioPackets && after.videoFrames > before.videoFrames, `${label}: remote call audio and decoded camera frames must actually arrive.`);
};
const stable = async (label, muted = false) => {
  await Promise.all(clients.map(client => client.page.waitForFunction(() => { const v = document.querySelector('.movie-video'); return v && !v.paused && v.readyState >= 3 && v.currentTime > 2; }, undefined, { timeout: 45000 })));
  await delay(1500);
  const deadline = Date.now() + 45000; let stableSince = Date.now(), samples = 0, maxDrift = 0, maxSpread = 0;
  while (Date.now() < deadline && Date.now() - stableSince < 10000) {
    const before = party.snapshot();
    const readings = await Promise.all(clients.map(client => client.page.evaluate(() => { const v = document.querySelector('.movie-video'); return { time: v.currentTime, at: Date.now(), paused: v.paused, ready: v.readyState, rate: v.playbackRate, seeking: v.seeking, pongs: window.testPongs.slice(-3) }; })));
    const after = party.snapshot();
    const immutable = ['mediaVersion', 'readinessVersion', 'updatedAt', 'position', 'paused', 'waiting'].every(key => before[key] === after[key]);
    if (!immutable || before.waiting || before.paused || Date.now() < after.updatedAt + 1000) stableSince = Date.now();
    else {
      const commonAt = Math.max(...readings.map(reading => reading.at));
      const projected = readings.map(reading => reading.time + (reading.paused ? 0 : (commonAt - reading.at) * reading.rate / 1000));
      for (const reading of readings) {
        assert.ok(!reading.paused && reading.ready >= 3, `${label}: decoded playback must remain advancing.`);
        const drift = Math.abs(reading.time - (before.position + Math.max(0, reading.at - before.updatedAt) / 1000)); maxDrift = Math.max(maxDrift, drift);
        assert.ok(drift < 1, `${label}: shared timeline drift ${drift.toFixed(3)}s must remain below one second: ${JSON.stringify(reading)}.`);
      }
      const spread = Math.max(...projected) - Math.min(...projected); maxSpread = Math.max(maxSpread, spread); assert.ok(spread < 1); samples++;
    }
    await delay(500);
  }
  assert.ok(Date.now() - stableSince >= 10000 && samples >= 15, `${label}: ten continuous stable seconds required.`);
  await health(label, muted);
  console.log(`${label}: ${samples} immutable-clock samples; max drift ${maxDrift.toFixed(3)}s; spread ${maxSpread.toFixed(3)}s.`);
};
const conditions = async (latency = 0, throughput = -1, type = 'wifi') => {
  // CDP HTTP throttling does not prove WebRTC packet loss. The OS process stop
  // above cuts real UDP/TCP/HTTP/WS; this adds the slower movie-download path.
  await session.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: throughput, uploadThroughput: throughput, connectionType: type });
};
try {
  await call.createRoom({ name: roomName }); await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const library = (await plex.library()).filter(item => item.type === 'movie');
  const item = library.find(item => item.title === process.env.TEST_MOVIE) || library[0]; assert.ok(item, 'A Plex movie is required.');
  const movie = plex.simplify(await plex.metadata(item.id));
  const chromeArgs = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  hostBrowser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true, args: chromeArgs });
  profile = await mkdtemp(path.join(os.tmpdir(), 'playparty-rtc-link-'));
  guestChrome = spawn(process.env.TEST_CHROME || '/usr/bin/google-chrome', ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', ...chromeArgs, 'about:blank'], { stdio: 'ignore' });
  let chromeError;
  guestChromeExit = new Promise(resolve => { guestChrome.once('exit', resolve); guestChrome.once('error', error => { chromeError = error; resolve(); }); });
  let debugPort;
  for (let attempt = 0; attempt < 100 && !debugPort && !chromeError; attempt++) {
    try { debugPort = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await delay(100); }
  }
  assert.ok(debugPort, 'The owned guest Chrome must expose its own debugging endpoint.');
  guestBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { noDefaults: true });
  for (let index = 0; index < 2; index++) {
    const context = index === 0 ? await hostBrowser.newContext({ permissions: ['camera', 'microphone'] }) : guestBrowser.contexts()[0];
    const client = { host: index === 0, context }; clients.push(client);
    await context.grantPermissions(['camera', 'microphone']); await context.addInitScript(instrument);
    if (client.host) await context.addCookies([{ name: 'test_owner', value: ownerCookie, url: origin }]);
    client.page = await context.newPage(); client.page.on('pageerror', error => errors.push(error.message)); await client.page.goto(origin); await join(client);
  }
  const post = (action, body = {}) => clients[0].page.evaluate(async ({ action, body }) => {
    const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
  }, { action, body });
  await post('select', { id: movie.id });
  await Promise.all(clients.map(client => client.page.waitForFunction(() => { const v = document.querySelector('.movie-video'); return v && !v.paused && v.readyState >= 3 && v.currentTime > 2; }, undefined, { timeout: 60000 })));
  await post('control', { action: 'seek', position: Math.min(600, Math.max(10, movie.duration / 3)) });
  await stable('RTC baseline');
  const guest = clients[1]; session = await guest.context.newCDPSession(guest.page); await session.send('Network.enable');
  await guest.page.getByRole('button', { name: 'Mute microphone', exact: true }).click(); await health('Muted guest baseline', true);
  for (const [label, seconds] of [['Short actual guest network outage', 5], ['Long actual guest network outage', 18]]) {
    const tasks = await guest.page.evaluate(() => window.testTasks);
    await cutNetwork(); await delay(1500);
    // Queue the same lightweight ping the App heartbeat sends. An asymmetric
    // queued ping must not poison the client's clock offset after restoration.
    if (seconds === 5) await guest.page.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events' && socket.readyState === WebSocket.OPEN).at(-1).send(JSON.stringify({ type: 'ping', sent: Date.now() })));
    const before = await Promise.all(clients.map(client => stats(client.page))); await delay(seconds * 1000); const after = await Promise.all(clients.map(client => stats(client.page)));
    const deltas = after.map((value, index) => ({ client: index === 0 ? 'host' : 'guest', packets: value.packets - before[index].packets,
      bytes: value.bytes - before[index].bytes, videoFrames: value.videoFrames - before[index].videoFrames, peers: value.peers }));
    console.log(`${label} measured receive deltas: ${JSON.stringify(deltas)}.`);
    assert.ok(deltas.every(delta => delta.packets === 0 && delta.bytes === 0), `${label}: stopping the guest NetworkService must actually stop inbound RTP in both directions.`);
    assert.ok(await guest.page.evaluate(previous => window.testTasks > previous + 10, tasks), 'Guest renderer JavaScript must keep running while only networking is stopped.');
    assert.equal(after[0].stateSockets, 1, 'The host must retain its own healthy party socket.');
    if (seconds > 8) assert.equal(await guest.page.locator('.movie-video').evaluate(v => v.paused), true, 'The guest must pause after its real state connection becomes stale.');
    await restoreNetwork(); await conditions();
    await stable(`${label} restored`, true);
  }
  const previousLocalPorts = (await stats(guest.page)).candidates.filter(pair => pair.protocol === 'udp' && pair.state === 'succeeded').map(pair => pair.localPort);
  const previousNetworkPid = await findNetworkProcess();
  assert.ok(await ownsNetworkProcess(previousNetworkPid));
  process.kill(previousNetworkPid, 'SIGKILL');
  let replacementNetworkPid;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const candidate = await findNetworkProcess(); if (candidate !== previousNetworkPid) { replacementNetworkPid = candidate; break; } } catch {}
    await delay(100);
  }
  assert.ok(replacementNetworkPid && await ownsNetworkProcess(replacementNetworkPid), 'Chrome must actually recreate its owned NetworkService with new UDP/TCP sockets.');
  await stable('Actual guest network socket recreation', true);
  const currentLocalPorts = (await stats(guest.page)).candidates.filter(pair => pair.protocol === 'udp' && pair.state === 'succeeded').map(pair => pair.localPort);
  assert.ok(currentLocalPorts.some(port => !previousLocalPorts.includes(port)), 'Socket recreation must actually select a new local UDP endpoint, closer to NAT/interface handoff.');
  console.log(`Guest NetworkService PID and selected UDP endpoint changed (${previousLocalPorts.join(',')} → ${currentLocalPorts.join(',')}); the same call devices/mute were retained.`);
  for (let index = 0; index < 3; index++) {
    await conditions(120, 200000, 'cellular4g'); await delay(5000);
    await cutNetwork(); await delay(2500); await restoreNetwork(); await conditions();
    await stable(`Simulated slower-network handoff ${index + 1}`, true);
  }
  console.log(`RTC recovery evidence: ${JSON.stringify(await guest.page.evaluate(() => ({ transitions: window.testPeerEvents, iceRestarts: window.testIceRestarts.length, captures: window.testCaptures.length })))}.`);
  assert.deepEqual(errors, [], 'Network faults cannot produce uncaught browser errors.');
} finally {
  try { await restoreNetwork(); } finally {
    await hostBrowser?.close().catch(() => {}); await guestBrowser?.close().catch(() => {});
    try { await close(); } finally {
      guestChrome?.kill('SIGTERM'); await guestChromeExit;
      try { if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      finally { await call.deleteRoom(roomName).catch(() => {}); }
    }
  }
}
