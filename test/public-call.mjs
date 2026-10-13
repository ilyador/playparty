// Exercise real HTTPS signaling and public IPv4 call media, using fake devices.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import assert from 'node:assert/strict';

try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const url = process.env.PUBLIC_URL;
assert.ok(url?.startsWith('https://'), 'Set PUBLIC_URL to the deployed HTTPS address.');
assert.ok(process.env.TEST_SSH_HOST, 'Set TEST_SSH_HOST to an SSH host with Node and Playwright installed.');
const publicIP = (await resolve4(new URL(url).hostname))[0];
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\'" + "'") + "'";
const remoteNode = shellQuote(process.env.TEST_REMOTE_NODE || 'node');
const remoteCommand = process.env.TEST_REMOTE_BROWSER_CACHE ? `PLAYWRIGHT_BROWSERS_PATH=${shellQuote(process.env.TEST_REMOTE_BROWSER_CACHE)} ${remoteNode}` : remoteNode;
const state = (await (await fetch(`${url}/api/session`)).json()).state;
assert.equal(state.participants.length, 0, 'Run this test when the party is empty.');
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];

function publicOnly(serverIP) {
  const Native = RTCPeerConnection;
  window.testPeers = [];
  const allowed = candidate => candidate?.split(' ')[4] === serverIP;
  const localDescription = description => ({ type: description.type, sdp: description.sdp.split('\r\n').filter(line => !line.startsWith('a=candidate:') || line.includes(' typ srflx')).join('\r\n') });
  window.RTCPeerConnection = class extends Native {
    constructor(...args) { super(...args); window.testPeers.push(this); }
    addIceCandidate(candidate) { return !candidate?.candidate || allowed(candidate.candidate) ? super.addIceCandidate(candidate) : Promise.resolve(); }
    async createOffer(...args) { return localDescription(await super.createOffer(...args)); }
    async createAnswer(...args) { return localDescription(await super.createAnswer(...args)); }
    setRemoteDescription(description) {
      if (description.sdp) description = { type: description.type, sdp: description.sdp.split('\r\n').filter(line => !line.startsWith('a=candidate:') || allowed(line.slice(2))).join('\r\n') };
      return super.setRemoteDescription(description);
    }
    set onicecandidate(handler) { super.onicecandidate = event => { if (!event.candidate || event.candidate.type === 'srflx') handler?.(event); }; }
    get onicecandidate() { return super.onicecandidate; }
  };
}

function mediaPlaying() {
  const videos = [...document.querySelectorAll('.face video.visible')];
  return videos.length >= 2 && videos.every(video => video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 2);
}

async function mediaStats() {
  const tracks = [], routes = [];
  for (const peer of window.testPeers) {
    const stats = await peer.getStats();
    for (const stat of stats.values()) {
      if (stat.type === 'inbound-rtp') tracks.push({ kind: stat.kind, bytes: stat.bytesReceived, frames: stat.framesDecoded });
      if (stat.type === 'transport' && stat.selectedCandidatePairId) {
        const selected = stats.get(stat.selectedCandidatePairId);
        const remote = stats.get(selected?.remoteCandidateId);
        routes.push({ address: remote?.address, protocol: remote?.protocol, port: remote?.port });
      }
    }
  }
  return { tracks, routes };
}

let browser, remote;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args });
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await context.addInitScript(publicOnly, publicIP);
  const page = await context.newPage();
  await page.goto(url);
  await page.locator('#name').fill('Connection Test Local');
  await page.getByRole('button', { name: 'Join', exact: true }).click();

  const script = `
const { chromium } = require(${JSON.stringify(process.env.TEST_REMOTE_PLAYWRIGHT || 'playwright')});
(async () => {
  const browser = await chromium.launch({ headless: true, args: ${JSON.stringify(args)} });
  try {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
    await context.addInitScript(${publicOnly.toString()}, ${JSON.stringify(publicIP)});
    const page = await context.newPage();
    await page.goto(${JSON.stringify(url)});
    await page.locator('#name').fill('Connection Test Remote');
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.waitForFunction(${mediaPlaying.toString()}, undefined, { timeout: 45000 });
    const result = await page.evaluate(${mediaStats.toString()});
    console.log('REMOTE PUBLIC MEDIA', JSON.stringify(result));
    if (!result.tracks.some(t => t.kind === 'video' && t.frames > 0) || !result.tracks.some(t => t.kind === 'audio' && t.bytes > 0)) throw Error('Remote camera/audio missing');
    if (!result.routes.some(r => r.address === ${JSON.stringify(publicIP)}) || result.routes.some(r => r.address && r.address !== ${JSON.stringify(publicIP)})) throw Error('Public IPv4 transport was not used');
    await page.waitForFunction(() => document.querySelectorAll('.face video.visible').length === 1, undefined, { timeout: 15000 });
    await page.getByRole('button', { name: 'Leave the call', exact: true }).click();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
  remote = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', process.env.TEST_SSH_HOST, remoteCommand], { stdio: ['pipe', 'inherit', 'inherit'] });
  const remoteExit = new Promise(resolve => remote.on('exit', resolve));
  remote.stdin.end(script);
  await page.waitForFunction(mediaPlaying, undefined, { timeout: 45000 });
  const result = await page.evaluate(mediaStats);
  console.log('LOCAL PUBLIC MEDIA', JSON.stringify(result));
  assert.ok(result.tracks.some(t => t.kind === 'video' && t.frames > 0));
  assert.ok(result.tracks.some(t => t.kind === 'audio' && t.bytes > 0));
  assert.ok(result.routes.some(route => route.address === publicIP) && result.routes.every(route => !route.address || route.address === publicIP));
  await page.getByRole('button', { name: 'Leave the call', exact: true }).click();
  assert.equal(await remoteExit, 0);
  console.log('Public IPv4 camera/audio verified in both directions.');
} finally {
  remote?.kill();
  await browser?.close();
}
