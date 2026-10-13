// Five actual app clients and LiveKit media, in an isolated room with fake devices.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';
import { cookies } from '../server/auth.mjs';

try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
assert.ok(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET, 'Configure the local LiveKit credentials.');
const origin = 'http://localhost:5177';
const roomName = `playparty-call-test-${randomUUID()}`;
const owner = randomUUID();
const internalUrl = process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880';
const call = new RoomServiceClient(internalUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const { server, party, close } = createApp({
  plex: { streams: new Map(), stop: async () => {}, library: async () => [] },
  authenticateOwner: header => cookies(header).test_owner === owner,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: internalUrl, origin, roomName, recordProgress: false,
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined,
});
let browser;
const pages = [], errors = [];
const publications = async muted => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const participants = await call.listParticipants(roomName);
    if (participants.length === 5 && participants.every(participant =>
      participant.tracks.length === 2 &&
      participant.tracks.some(track => track.source === TrackSource.CAMERA && !track.muted) &&
      participant.tracks.some(track => track.source === TrackSource.MICROPHONE && track.muted === muted))) return participants;
    await delay(100);
  }
  assert.fail(`Five camera/microphone publications did not reach muted=${muted}.`);
};
try {
  await call.createRoom({ name: roomName });
  await new Promise(resolve => server.listen(5177, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  for (let index = 0; index < 5; index++) {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1000, height: 800 } });
    await context.addInitScript(() => {
      const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), Native = RTCPeerConnection;
      window.testMediaRequests = []; window.testNativeTracks = []; window.testPeers = [];
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.testMediaRequests.push(constraints);
        const stream = await getMedia(constraints); window.testNativeTracks.push(...stream.getTracks()); return stream;
      };
      window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.testPeers.push(this); } };
    });
    if (index === 0) await context.addCookies([{ name: 'test_owner', value: owner, url: origin }]);
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#name').fill(index === 0 ? 'Test Host' : `Test Guest ${index}`);
    if (index === 0) await page.getByRole('switch', { name: 'I am the host' }).check();
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor();
  }
  await publications(false);
  await Promise.all(pages.map(page => page.waitForFunction(() => {
    const videos = [...document.querySelectorAll('.face video.visible')];
    return videos.length === 5 && videos.every(video => video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0) &&
      document.querySelectorAll('audio.call-audio').length === 4;
  }, undefined, { timeout: 45000 })));
  for (const page of pages) {
    const stats = await page.evaluate(async () => {
      const inbound = [];
      for (const peer of window.testPeers) for (const stat of (await peer.getStats()).values())
        if (stat.type === 'inbound-rtp') inbound.push({ kind: stat.kind, bytes: stat.bytesReceived, frames: stat.framesDecoded });
      return { inbound, captures: window.testMediaRequests.length, audioOutputs: document.querySelectorAll('audio.call-audio').length };
    });
    assert.equal(stats.captures, 1);
    assert.equal(stats.audioOutputs, 4);
    assert.equal(stats.inbound.filter(track => track.kind === 'audio' && track.bytes > 0).length, 4);
    assert.equal(stats.inbound.filter(track => track.kind === 'video' && track.frames > 0).length, 4);
  }
  const sixth = await fetch(`${origin}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{"name":"Sixth guest","host":false}' });
  assert.equal(sixth.status, 200);
  assert.equal(party.members.size, 6);
  const sixthCookie = sixth.headers.get('set-cookie').split(';')[0];
  const sixthLeft = await fetch(`${origin}/api/leave`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: sixthCookie }, body: '{}' });
  assert.equal(sixthLeft.status, 200);
  assert.equal(party.members.size, 5);
  await Promise.all(pages.map(page => page.getByRole('button', { name: 'Mute microphone', exact: true }).click()));
  for (const page of pages) assert.ok(await page.evaluate(() => window.testPeers.flatMap(peer => peer.getSenders()).filter(sender => sender.track?.kind === 'audio').every(sender => !sender.track.enabled)));
  await publications(true);
  await Promise.all(pages.map(page => page.getByRole('button', { name: 'Turn on microphone', exact: true }).click()));
  await publications(false);
  for (const page of pages) {
    assert.equal(await page.evaluate(() => window.testMediaRequests.length), 1);
    assert.ok(await page.evaluate(() => window.testPeers.flatMap(peer => peer.getSenders()).filter(sender => sender.track?.kind === 'audio').every(sender => sender.track.enabled)));
  }
  const host = pages[0];
  await host.getByRole('button', { name: 'Turn off camera', exact: true }).click();
  await host.waitForFunction(() => window.testNativeTracks.filter(track => track.kind === 'video').every(track => track.readyState === 'ended'));
  await host.getByRole('button', { name: 'Turn on camera', exact: true }).click();
  await publications(false);
  await Promise.all(pages.map(page => page.waitForFunction(() => {
    const videos = [...document.querySelectorAll('.face video.visible')];
    return videos.length === 5 && videos.every(video => video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0);
  }, undefined, { timeout: 30000 })));
  const cameraRecovery = await host.evaluate(() => ({
    captures: window.testMediaRequests,
    microphones: window.testNativeTracks.filter(track => track.kind === 'audio').length,
    liveMicrophones: window.testNativeTracks.filter(track => track.kind === 'audio' && track.readyState === 'live' && track.enabled).length,
    liveCameras: window.testNativeTracks.filter(track => track.kind === 'video' && track.readyState === 'live').length,
    senders: window.testPeers.flatMap(peer => peer.getSenders()).filter(sender => sender.track?.readyState === 'live').map(sender => sender.track.kind),
  }));
  assert.equal(cameraRecovery.captures.length, 2);
  assert.equal(cameraRecovery.captures[1].audio, false);
  assert.ok(cameraRecovery.captures[1].video);
  assert.equal(cameraRecovery.microphones, 1);
  assert.equal(cameraRecovery.liveMicrophones, 1);
  assert.equal(cameraRecovery.liveCameras, 1);
  assert.deepEqual(cameraRecovery.senders.sort(), ['audio', 'video']);
  for (const page of pages) assert.equal(await page.locator('audio.call-audio').count(), 4);
  await Promise.all(pages.map(page => page.getByRole('button', { name: 'Leave the call', exact: true }).click()));
  await Promise.all(pages.map(page => page.getByRole('button', { name: 'Join', exact: true }).waitFor()));
  for (const page of pages) assert.ok(await page.evaluate(() => window.testNativeTracks.every(track => track.readyState === 'ended')));
  assert.equal(party.members.size, 0);
  assert.deepEqual(errors, []);
  console.log('Five clients each received four live camera/audio streams; mic mute/unmute retained capture; camera off/on acquired only one replacement camera with no extra mic or duplicate sender; sixth guest accepted; leave released all devices.');
} finally {
  await browser?.close();
  await close();
  await call.deleteRoom(roomName).catch(() => {});
}
