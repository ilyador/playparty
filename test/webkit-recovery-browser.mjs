// Safari-adjacent recovery with real decoded video in mobile WebKit.
// Linux WebKit uses Hls.js/MSE here: it cannot prove iOS native-HLS,
// microphone permission persistence, device sleep, or radio handover.
// Physical camera/microphone access is denied; autoplay/media clocks are real.
// TEST_WEBKIT_FOCUS=paused runs just the paused-refresh recovery guard.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { webkit } from 'playwright';
import { RoomServiceClient } from 'livekit-server-sdk';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const focus = process.env.TEST_WEBKIT_FOCUS || 'all';
const focusPaused = focus === 'paused';
const port = Number(process.env.TEST_WEBKIT_PORT || 5182);
const origin = `http://localhost:${port}`;
const ownerCookie = randomUUID(), roomName = `playparty-webkit-recovery-${randomUUID()}`;
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const simplify = plex.simplify.bind(plex);
plex.simplify = item => ({ ...simplify(item), resumePosition: 0 });
const call = new RoomServiceClient(process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const recentTelemetry = [];
const { server, party, close } = createApp({ plex, authenticateOwner: header => cookies(header).test_owner === ownerCookie,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880', livekitUrl: 'ws://localhost:7880',
  origin, roomName, recordProgress: false,
  logPlayback: sample => { recentTelemetry.push(sample); if (recentTelemetry.length > 25) recentTelemetry.shift(); },
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined });
let browser, context, page, sessionCookie, phase = 'setup';
let blockedEvents = false, rejectedHandshakes = 0, rejectedMedia = 0;
const pageErrors = [], findings = [];
server.prependListener('upgrade', (request, socket) => {
  if (blockedEvents && request.url === '/events') { rejectedHandshakes++; socket.destroy(); }
});
const instrument = () => {
  navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Physical test devices denied', 'NotAllowedError'); };
  window.testSockets = []; window.testLastStateAt = 0; window.testStateMessages = 0; window.testMoviePlayingEvents = 0;
  document.addEventListener('playing', event => { if (event.target?.classList?.contains('movie-video')) window.testMoviePlayingEvents++; }, true);
  const NativeSocket = WebSocket;
  window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.testSockets.push(this); if (new URL(this.url).pathname === '/events') this.addEventListener('message', event => { try { if (JSON.parse(event.data).type === 'state') { window.testLastStateAt = Date.now(); window.testStateMessages++; } } catch {} }); } };
};
const mediaState = () => {
  const video = document.querySelector('.movie-video');
  if (!video) return { present: false };
  if (typeof video.requestVideoFrameCallback === 'function' && window.testFrameVideo !== video) {
    window.testFrameVideo = video; window.testPresentedFrames = 0; window.testLastFrameTime = undefined;
    const presented = (_now, metadata) => { if (window.testFrameVideo !== video) return; window.testPresentedFrames++; window.testLastFrameTime = metadata.mediaTime; video.requestVideoFrameCallback(presented); };
    video.requestVideoFrameCallback(presented);
  }
  return { present: true, time: video.currentTime, at: Date.now(),
    stateAgeMs: window.testLastStateAt ? Date.now() - window.testLastStateAt : -1, stateMessages: window.testStateMessages || 0,
    ready: video.readyState, paused: video.paused, rate: video.playbackRate, width: video.videoWidth, height: video.videoHeight,
    frames: video.getVideoPlaybackQuality?.().totalVideoFrames || video.webkitDecodedFrameCount || 0,
    presentedFrames: window.testPresentedFrames || 0, lastFrameTime: window.testLastFrameTime,
    mseSource: video.currentSrc.startsWith('blob:'), error: video.error?.code || 0, seeking: video.seeking,
    buffered: Array.from({ length: video.buffered.length }, (_, index) => ({ start: video.buffered.start(index), end: video.buffered.end(index) })),
    blocked: document.querySelector('.movie-player')?.classList.contains('playback-blocked'),
    legacyOverlay: [...document.querySelectorAll('button')].some(button => /tap to (watch|play)/i.test(button.textContent || '')),
    startControl: Boolean(document.querySelector('[aria-label="Start playback"]')),
    tracks: [...video.textTracks].map(track => ({ mode: track.mode, cues: track.cues?.length || 0,
      active: [...(track.activeCues || [])].map(cue => ({ start: cue.startTime, end: cue.endTime })) })) };
};
const playing = () => { const video = document.querySelector('.movie-video'); return video && !video.paused && video.readyState >= 3 && video.currentTime > 2; };
const post = async (route, body = {}) => {
  const response = await fetch(`${origin}/api/${route}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: `test_owner=${ownerCookie}; playparty_session=${sessionCookie || ''}` }, body: JSON.stringify(body) });
  assert.ok(response.ok, `The isolated ${route} request must succeed.`);
  return response.json();
};
const join = async () => {
  await page.locator('#name').fill('WebKit Test Host');
  await page.getByRole('switch', { name: 'I am the host' }).check();
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByRole('button', { name: 'Leave the call', exact: true }).waitFor({ timeout: 30000 });
  sessionCookie = (await context.cookies(origin)).find(cookie => cookie.name === 'playparty_session')?.value;
  assert.ok(sessionCookie, 'Joining must create a real isolated session.');
};
const waitPlaying = async (timeout = 60000) => {
  // A genuine browser autoplay rejection may require the existing small play
  // control. Do not grant autoplay permission or mock HTMLMediaElement.play.
  try { await page.waitForFunction(playing, undefined, { timeout: Math.min(timeout, 10000) }); }
  catch (error) {
    const start = page.getByRole('button', { name: 'Start playback', exact: true });
    if (await start.isVisible()) { await start.click(); findings.push('A real autoplay rejection required the compact play control.'); }
    else if (timeout <= 10000) throw error;
    await page.waitForFunction(playing, undefined, { timeout });
  }
};
const assertStable = async label => {
  await waitPlaying();
  const deadline = Date.now() + 45000;
  let stableSince = Date.now(), samples = 0, maxDrift = 0, firstFrames, lastFrames, firstPresented, lastPresented, lastSample;
  while (Date.now() < deadline && Date.now() - stableSince < 10000) {
    const before = party.snapshot(), sample = await page.evaluate(mediaState), after = party.snapshot();
    const sameClock = ['mediaVersion', 'readinessVersion', 'updatedAt', 'position', 'paused', 'waiting'].every(key => before[key] === after[key]);
    if (!sameClock || after.paused || after.waiting || Date.now() < after.updatedAt + 1000) stableSince = Date.now();
    else {
      const drift = Math.abs(sample.time - (before.position + Math.max(0, sample.at - before.updatedAt) / 1000));
      assert.ok(drift < 1, `${label}: actual playback drift ${drift.toFixed(3)}s must stay below one second.`);
      assert.ok(!sample.paused && sample.ready >= 3 && sample.width > 0 && sample.height > 0 && sample.mseSource, `${label}: actual WebKit MSE decoding must advance.`);
      assert.equal(sample.error, 0, `${label}: no native media errors.`);
      assert.equal(sample.blocked, false, `${label}: playing video cannot retain a blocked-play class.`);
      assert.equal(sample.legacyOverlay, false, `${label}: no stale Tap to watch overlay.`);
      assert.equal(sample.startControl, false, `${label}: playing video cannot retain a Start playback control.`);
      lastSample = sample; firstFrames ??= sample.frames; lastFrames = sample.frames; firstPresented ??= sample.presentedFrames; lastPresented = sample.presentedFrames; maxDrift = Math.max(maxDrift, drift); samples++;
    }
    await delay(500);
  }
  assert.ok(Date.now() - stableSince >= 10000 && samples >= 15, `${label}: require ten continuous stable seconds.`);
  assert.ok(lastFrames > firstFrames || lastPresented > firstPresented, `${label}: actual decoded/presented frames must advance, rather than a fake clock.`);
  if (Number.isFinite(lastSample.lastFrameTime)) assert.ok(Math.abs(lastSample.time - lastSample.lastFrameTime) < 1, `${label}: the actual presented frame must match the playback clock.`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: mobile viewport must not overflow horizontally.`);
  console.log(JSON.stringify({ label, result: 'pass', samples, maxDrift: Number(maxDrift.toFixed(3)), decodedFrames: lastFrames - firstFrames, presentedFrames: lastPresented - firstPresented }));
};
const assertCaptions = async label => {
  await page.waitForFunction(() => { const video = document.querySelector('.movie-video'); return video && !video.paused && [...video.textTracks].some(track => track.mode === 'showing' && track.activeCues?.length); }, undefined, { timeout: 45000 });
  const sample = await page.evaluate(mediaState);
  assert.ok(sample.tracks.some(track => track.mode === 'showing' && track.active.some(cue => cue.start <= sample.time + 0.25 && cue.end >= sample.time - 0.25)), `${label}: actual active WebVTT cues must match the decoded movie clock.`);
  assert.ok(sample.frames > 0 && sample.width > 0);
  console.log(JSON.stringify({ label, result: 'pass', tracks: sample.tracks.length, activeCues: sample.tracks.reduce((count, track) => count + track.active.length, 0) }));
};
try {
  await call.createRoom({ name: roomName });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  browser = await webkit.launch({ headless: true, env: { ...process.env, WEBKIT_GST_ENABLE_HLS_SUPPORT: '0' } });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'test_owner', value: ownerCookie, url: origin }]);
  await context.addInitScript(instrument);
  page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.name));
  await page.goto(origin);
  const capability = await page.evaluate(() => ({ mediaSource: typeof MediaSource === 'function', nativeHls: document.createElement('video').canPlayType('application/vnd.apple.mpegurl') }));
  assert.ok(capability.mediaSource && !capability.nativeHls, 'The explicitly tested engine is Linux WebKit MSE, not iOS native HLS.');
  console.log(JSON.stringify({ engine: 'WebKit', mobile: '390x844 touch', autoplayMocked: false, capability }));
  phase = 'library';
  let movie, subtitle;
  for (const candidate of (await plex.library()).filter(item => item.type === 'movie').slice(0, 30)) {
    const metadata = await plex.metadata(candidate.id);
    const stream = (metadata.Media?.[0]?.Part?.[0]?.Stream || []).find(track => Number(track.streamType) === 3 && String(track.codec).toLowerCase() === 'srt');
    if (stream) { movie = plex.simplify(metadata); subtitle = String(stream.id); break; }
  }
  assert.ok(movie && subtitle, 'A movie with actual text subtitles is required.');
  const seek = Math.floor(Math.min(600, movie.duration * 0.25));
  phase = 'join'; await join();
  phase = 'baseline'; await post('select', { id: movie.id }); await assertStable('Mobile WebKit baseline');
  if (!focusPaused) {
    phase = 'movie-only retry';
    await page.route('**/api/playback', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture movie retry' }) }));
    await page.getByLabel('Subtitles', { exact: true }).selectOption(subtitle);
    await page.getByText('Fixture movie retry', { exact: true }).waitFor();
    await page.unroute('**/api/playback');
    const retryBox = await page.getByRole('button', { name: 'Retry movie', exact: true }).boundingBox();
    assert.ok(retryBox, 'The mobile Retry button must be visible.');
    const stopBox = await page.getByRole('button', { name: 'Stop movie', exact: true }).boundingBox();
    assert.ok(stopBox, 'Stop must remain visible during a movie error.');
    await page.waitForFunction(() => {
      const stop = document.querySelector('[aria-label="Stop movie"]');
      if (!stop) return false;
      const box = stop.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === stop;
    }, undefined, { timeout: 3000 });
    const stopHit = await page.evaluate(({ x, y, width, height }) => document.elementFromPoint(x + width / 2, y + height / 2)?.closest('button')?.getAttribute('aria-label'), stopBox);
    const errorControls = await page.locator('.movie-controls').evaluate(controls => ({ pointerEvents: getComputedStyle(controls).pointerEvents,
      opacity: getComputedStyle(controls).opacity, paused: document.querySelector('.movie-video')?.paused }));
    assert.equal(stopHit, 'Stop movie', `The error overlay must preserve access to Stop: ${JSON.stringify({ hit: stopHit || null, ...errorControls })}`);
    const retryHit = await page.evaluate(({ x, y, width, height }) => document.elementFromPoint(x + width / 2, y + height / 2)?.closest('button')?.textContent?.trim(), retryBox);
    assert.equal(retryHit, 'Retry movie', 'The actual mobile Retry button must receive the pointer above the movie controls.');
    await page.getByRole('button', { name: 'Retry movie', exact: true }).click();
    await assertStable('Mobile movie-only Retry without leaving the call');
    phase = 'captions'; await page.getByLabel('Subtitles', { exact: true }).selectOption(subtitle);
    await post('control', { action: 'seek', position: seek }); await assertStable('Caption playback after seek'); await assertCaptions('Caption seek');
    await post('control', { action: 'seek', position: seek + 30 }); await assertStable('Second caption seek'); await assertCaptions('Second caption seek');
    phase = 'refresh'; await page.reload(); await join(); await assertStable('Refresh and rejoin mid-play');
    await page.getByLabel('Subtitles', { exact: true }).selectOption(subtitle); await assertCaptions('Captions after refresh');
    phase = 'leave/rejoin'; await page.getByRole('button', { name: 'Leave the call', exact: true }).click(); await page.locator('#name').waitFor();
    assert.equal(party.members.size, 0, 'The last explicit departure must retire the empty party.');
    assert.equal(party.movie, null, 'An empty party must not retain its old selected movie.');
    assert.equal(party.ready.size, 0);
    assert.equal(party.wantsPlay, false);
    assert.equal(plex.streams.size, 0, 'The last departure must reclaim its actual Plex transcode.');
    await delay(2500); await join();
    assert.equal(await page.locator('.movie-video').count(), 0, 'A fresh host must enter selection instead of resuming an abandoned party.');
    await post('select', { id: movie.id }); await assertStable('New movie after last-person departure and rejoin');
  }
  phase = 'paused return'; await post('control', { action: 'pause' });
  await page.waitForFunction(() => document.querySelector('.movie-video')?.paused);
  const pausedAt = party.currentPosition();
  await page.reload(); await join(); await page.locator('.movie-video').waitFor(); await delay(6000);
  assert.equal(party.currentPosition(), pausedAt, 'Refreshing a manually paused movie must not advance its shared clock.');
  assert.equal(await page.locator('.movie-video').evaluate(video => video.paused), true, 'Rejoining a manually paused movie must remain paused.');
  assert.equal(await page.evaluate(() => window.testMoviePlayingEvents), 0, 'A manually paused refresh must not emit even a brief real playing event.');
  await post('control', { action: 'play' }); await assertStable('Play after paused refresh');
  if (!focusPaused) {
    phase = 'media outage';
    await page.route('**/api/stream/**', async route => { rejectedMedia++; await route.abort('connectionrefused'); });
    await post('control', { action: 'seek', position: seek + 60 });
    await delay(38000);
    assert.ok(rejectedMedia >= 1 && party.paused && party.wantsPlay, 'A real cold movie outage must hold the shared timeline.');
    const held = party.currentPosition(); await delay(1500); assert.equal(party.currentPosition(), held);
    await page.unroute('**/api/stream/**'); await assertStable('WebKit movie HTTP restored');
    phase = 'offline restore';
    blockedEvents = true;
    await page.evaluate(() => window.testSockets.filter(socket => new URL(socket.url).pathname === '/events').at(-1).close());
    await page.waitForFunction(() => document.querySelector('.movie-video')?.paused);
    const offlineTime = await page.locator('.movie-video').evaluate(video => video.currentTime);
    // Reject a real WS reconnect first; offline HTTP emulation alone need not
    // sever an existing socket and may prevent the attempted handshake locally.
    const handshakeDeadline = Date.now() + 5000;
    while (!rejectedHandshakes && Date.now() < handshakeDeadline) await delay(100);
    assert.ok(rejectedHandshakes > 0, 'The outage must reject real party WebSocket handshakes.');
    await context.setOffline(true);
    await post('control', { action: 'pause' }); await delay(12000);
    assert.equal(await page.locator('.movie-video').evaluate(video => video.currentTime), offlineTime, 'An offline client must not continue playing from stale state.');
    blockedEvents = false; await context.setOffline(false); await delay(3500);
    assert.equal(await page.locator('.movie-video').evaluate(video => video.paused), true, 'A pause issued while offline must survive network restoration.');
    await post('control', { action: 'play' }); await assertStable('WebKit HTTP and party socket restored');
    phase = 'landscape'; await page.setViewportSize({ width: 844, height: 390 });
    await assertStable('Mobile WebKit landscape');
  }
  assert.equal(pageErrors.length, 0, 'Recoveries must not create uncaught browser exceptions.');
  console.log(JSON.stringify({ engine: 'WebKit MSE', focus, result: 'pass', pageErrors: pageErrors.length, rejectedMedia, rejectedHandshakes,
    requiredRealAutoplayGestures: findings.length, limitations: ['Not iOS native HLS', 'No physical microphone/camera', 'No device sleep or radio handover'] }));
} catch (error) {
  console.log(JSON.stringify({ engine: 'WebKit MSE', result: 'failed', phase, errorType: error.name,
    message: /must|cannot|require|The |An |A |movie|client|viewport|caption|clock|playback/i.test(error.message) ? error.message.split('\n')[0] : 'Browser operation failed',
    media: page ? await page.evaluate(mediaState).catch(() => ({ unavailable: true })) : {},
    state: { paused: party.paused, waiting: party.wantsPlay, position: party.currentPosition(), ready: party.ready.size }, recentTelemetry }));
  process.exitCode = 1;
} finally {
  blockedEvents = false; await context?.setOffline(false).catch(() => {}); await browser?.close(); await close(); await call.deleteRoom(roomName).catch(() => {});
}
