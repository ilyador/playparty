// Real Plex/LiveKit integration, using an isolated server and fake camera/mic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const testOwner = randomUUID();
const playbackEvents = [];
const { server, party, close } = createApp({ plex, authenticateOwner: header => cookies(header).test_owner === testOwner,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitUrl: 'ws://localhost:7880', origin: 'http://localhost:5176', movieMbps: 70, roomName: `playparty-test-${randomUUID()}`, recordProgress: false,
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined, logPlayback: sample => playbackEvents.push({ ...sample, testAt: Date.now() }) });
await new Promise(resolve => server.listen(5176, '127.0.0.1', resolve));
let browser;
const output = '.impeccable/review';
if (process.env.TEST_CAPTURE === '1') fs.mkdirSync(output, { recursive: true });
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const playing = () => { const v = document.querySelector('.movie-video'); return v && v.readyState >= 3 && v.currentTime > 2 && !v.paused; };
const instrument = () => {
  const Native = window.RTCPeerConnection, NativeSocket = window.WebSocket;
  window.testPeers = [];
  window.testMediaRequests = [];
  window.testClock = {};
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      if (new URL(this.url).pathname === '/events') this.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') {
          const received = Date.now();
          window.testClock = { offsetMs: message.serverTime - (received + message.sent) / 2, rttMs: received - message.sent };
        }
      });
    }
  };
  for (const name of ['play', 'playing', 'timeupdate']) document.addEventListener(name, event => { if (window.testMissingMediaEvents && event.target?.classList.contains('movie-video')) event.stopImmediatePropagation(); }, true);
  const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = constraints => { window.testMediaRequests.push(constraints); return getMedia(constraints); };
  window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.testPeers.push(this); } };
};
try {
  const library = await plex.library();
  const movies = library.filter(item => item.type === 'movie');
  assert.ok(movies.length, 'The Plex library must contain a movie.');
  const requested = process.env.TEST_MOVIE && movies.find(item => item.title === process.env.TEST_MOVIE);
  const candidates = requested ? [requested, ...movies.slice(0, 30).filter(item => item.id !== requested.id)] : movies.slice(0, 30);
  const details = await Promise.all(candidates.map(async item => plex.simplify(await plex.metadata(item.id))));
  const textMovie = details.find(item => item.subtitles.some(track => !track.burn));
  const imageMovie = details.find(item => item.subtitles.some(track => track.burn));
  const movie = process.env.TEST_MOVIE ? details.find(item => item.title === process.env.TEST_MOVIE) : textMovie || details[0];
  assert.ok(movie, 'TEST_MOVIE must name a movie in the library.');
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome', headless: true, args });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
  await context.addInitScript(instrument);
  await context.addCookies([{ name: 'test_owner', value: testOwner, url: 'http://localhost:5176' }]);
  const page = await context.newPage();
  const hostStreams = [];
  page.on('response', async response => { if (response.url().endsWith('/api/playback') && response.ok()) hostStreams.push(await response.json()); });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) console.log('BROWSER', message.text().slice(0, 350)); });
    const screenshot = async name => { if (process.env.TEST_CAPTURE === '1') await page.screenshot({ path: `${output}/${name}.png` }); };
  const post = (path, body = {}) => page.evaluate(async ({path, body}) => {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    return data;
  }, {path, body});
  await page.goto('http://localhost:5176');
  await page.locator('#name').fill('Test Host');
  await page.getByRole('switch', { name: 'I am the host' }).check();
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.waitForSelector('.face video.visible', { timeout: 20000 });
  await page.getByRole('button', { name: 'Choose a movie', exact: true }).click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.waitForSelector('.poster-item img');
  await page.evaluate(async () => { await Promise.all([...document.querySelectorAll('.poster-image img')].map(img => img.decode().catch(() => {}))); });
  await screenshot('library-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('library-mobile');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: new RegExp('^' + movie.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
  await page.waitForFunction(playing, undefined, { timeout: 45000 });
  const capture = await page.evaluate(() => window.testMediaRequests);
  assert.equal(capture.length, 1);
  assert.ok(capture[0].audio && capture[0].video);
  assert.equal(capture[0].audio.echoCancellation, true);
  assert.equal(capture[0].audio.noiseSuppression, true);
  assert.ok(playbackEvents.some(sample => sample.event === 'capture-request'), 'Actual capture attempts must reach diagnostics.');
  assert.ok(playbackEvents.some(sample => sample.event === 'microphone-status' && sample.microphoneEnabled && sample.echoCancellation), 'Diagnostics must distinguish a working microphone and applied cancellation.');
  console.log('Real movie playback and a single camera/microphone request with echo cancellation connected.');

  const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'], ...(process.env.TEST_REMOTE === '1' ? { extraHTTPHeaders: { 'X-Forwarded-For': '198.51.100.10' } } : {}) });
  await guestContext.addInitScript(instrument);
  const guest = await guestContext.newPage();
  const remoteNetwork = process.env.TEST_REMOTE === '1' ? await guestContext.newCDPSession(guest) : null;
  const guestStreams = [];
  guest.on('response', async response => { if (response.url().endsWith('/api/playback') && response.ok()) guestStreams.push(await response.json()); });
  if (remoteNetwork) await remoteNetwork.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 200000, uploadThroughput: 1000000 });
  guest.on('pageerror', error => errors.push(error.message));
  await guest.goto('http://localhost:5176');
  await guest.locator('#name').fill('Test Guest');
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await guest.waitForFunction(playing, undefined, { timeout: 45000 });
  const assertSustainedSynchronization = async label => {
    let viewerDrift = 0, timelineDrift = 0, samples = 0, healthySince, hold, holds = 0, heldMs = 0, localWaitSince;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const snapshot = party.snapshot();
      const positions = await Promise.all([page, guest].map(viewer => viewer.locator('.movie-video').evaluate(video => ({ position: video.currentTime, paused: video.paused, readyState: video.readyState, seeking: video.seeking, rate: video.playbackRate, clock: window.testClock, at: Date.now() }))));
      const absolute = positions.map((sample, index) => ({ ...sample, position: sample.position + (index === 0 ? hostStreams : guestStreams).at(-1).offset }));
      const after = party.snapshot();
      if (['mediaVersion', 'readinessVersion', 'updatedAt', 'position', 'paused', 'waiting'].some(key => snapshot[key] !== after[key])) {
        healthySince = localWaitSince = undefined;
        await page.waitForTimeout(500);
        continue;
      }
      const now = Date.now();
      if (!snapshot.paused && now < snapshot.updatedAt) { healthySince = localWaitSince = undefined; await page.waitForTimeout(500); continue; }
      if (snapshot.paused) {
        healthySince = localWaitSince = undefined;
        if (!hold || hold.version !== snapshot.readinessVersion) {
          if (hold) heldMs += now - hold.at;
          hold = { at: now, position: snapshot.position, version: snapshot.readinessVersion }; holds++;
          const reasons = playbackEvents.filter(sample => ['shared-buffering', 'quality-change', 'stream-start', 'viewer-ready', 'shared-resume', 'waiting', 'playing', 'ready', 'seek-recovery', 'sync-recovery', 'state-stale'].includes(sample.event)).slice(-8).map(sample => ({ event: sample.event, viewer: sample.viewer === 'owner' ? 'host' : sample.viewer ? 'guest' : undefined, qualityReason: sample.qualityReason, readyState: sample.readyState }));
          console.log(`${label}: shared hold ${JSON.stringify({ paused: snapshot.paused, waiting: snapshot.waiting, media: absolute.map(sample => ({ paused: sample.paused, readyState: sample.readyState, seeking: sample.seeking })), reasons })}`);
        }
        if (snapshot.paused && now - hold.at >= 750) {
          assert.equal(snapshot.position, hold.position, `${label}: buffering must freeze the shared timeline.`);
          assert.ok(absolute.every(sample => sample.paused), `${label}: both viewers must stop during an established shared buffering hold.`);
        }
      } else if (absolute.every(sample => !sample.paused && sample.readyState >= 3 && !sample.seeking)) {
        if (hold) { heldMs += now - hold.at; hold = undefined; }
        localWaitSince = undefined; healthySince ??= now;
        const difference = Math.abs(absolute[0].position - absolute[1].position);
        viewerDrift = Math.max(viewerDrift, difference);
        assert.ok(difference < 1, `${label}: viewers drifted ${difference.toFixed(3)} seconds apart.`);
        for (const [index, sample] of absolute.entries()) {
          const target = Math.min(snapshot.position + Math.max(0, sample.at - snapshot.updatedAt) / 1000, snapshot.movie.duration);
          const drift = Math.abs(sample.position - target);
          timelineDrift = Math.max(timelineDrift, drift);
          assert.ok(drift < 1, `${label}: a viewer drifted ${drift.toFixed(3)} seconds from the shared timeline. ${JSON.stringify({ viewer: index === 0 ? 'host' : 'guest', drift: sample.position - target, position: sample.position, target, rate: sample.rate, readyState: sample.readyState, seeking: sample.seeking, clock: sample.clock, recent: playbackEvents.filter(event => ['correction', 'sync-recovery', 'seek-recovery', 'shared-buffering', 'shared-resume', 'quality-change', 'stream-start'].includes(event.event)).slice(-6).map(event => ({ event: event.event, viewer: event.viewer === 'owner' ? 'host' : 'guest', drift: event.drift, qualityReason: event.qualityReason, ageMs: now - event.testAt })) })}`);
        }
        samples++;
        if (now - healthySince >= 10000) {
          console.log(`${label}: ${samples} settled samples, ten continuous healthy seconds; maximum viewer drift ${viewerDrift.toFixed(3)} s, shared-timeline drift ${timelineDrift.toFixed(3)} s; ${holds} shared holds totaling ${(heldMs / 1000).toFixed(3)} s.`);
          return;
        }
      } else {
        healthySince = undefined; localWaitSince ??= now;
        assert.ok(now - localWaitSince < 1500, `${label}: an unready client cannot advance the shared timeline for more than 1.5 seconds.`);
      }
      await page.waitForTimeout(500);
    }
    assert.fail(`${label}: ten continuous synchronized playback seconds were not reached within 45 seconds (${holds} shared holds).`);
  };
  if (process.env.TEST_REMOTE === '1') {
    const deadline = Date.now() + 45000;
    while (!guestStreams.some(stream => stream.remote && stream.currentBitrate < stream.maxBitrate) && Date.now() < deadline) await guest.waitForTimeout(250);
    assert.ok(guestStreams.some(stream => stream.remote && stream.currentBitrate < stream.maxBitrate), 'Only the remote viewer must request a lower stream cap under pressure.');
    await remoteNetwork.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForFunction(playing, undefined, { timeout: 45000 });
    await guest.waitForFunction(playing, undefined, { timeout: 45000 });
    await assertSustainedSynchronization('Remote recovery after 200000 B/s download and 20 ms latency');
    assert.ok(playbackEvents.some(sample => sample.event === 'stream-start' && sample.viewer === 'owner' && sample.remote === false && sample.maxBitrate === 0), 'Local playback must retain its unrestricted compatible stream.');
    console.log('Throttled remote playback lowered its own Plex stream cap and resumed; local playback remained unrestricted.');
  }
  assert.ok(Math.abs(await page.locator('.movie-video').evaluate(v => v.currentTime) - await guest.locator('.movie-video').evaluate(v => v.currentTime)) < 1, 'Viewers must start within one second of each other.');
  await page.waitForFunction(() => [...document.querySelectorAll('.face video.visible')].length >= 2, undefined, { timeout: 25000 });
  const media = await page.evaluate(async () => {
    const tracks = [];
    for (const pc of window.testPeers) for (const stat of (await pc.getStats()).values())
      if (stat.type === 'inbound-rtp') tracks.push({ kind: stat.kind, bytes: stat.bytesReceived, frames: stat.framesDecoded });
    return tracks;
  });
  assert.ok(media.some(track => track.kind === 'video' && track.frames > 0));
  assert.ok(media.some(track => track.kind === 'audio' && track.bytes > 0));
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  assert.ok(await page.evaluate(() => window.testPeers.flatMap(pc => pc.getSenders()).filter(s => s.track?.kind === 'audio').every(s => s.track.enabled === false)), 'Mute must disable native outgoing microphone tracks.');
  await page.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
  assert.ok(await page.evaluate(() => window.testPeers.flatMap(pc => pc.getSenders()).filter(s => s.track?.kind === 'audio').every(s => s.track.enabled === true)));
  assert.equal(await page.evaluate(() => window.testMediaRequests.length), 1, 'Microphone mute/unmute must retain the existing capture.');

  await page.setViewportSize({ width: 852, height: 393 });
  const landscape = await page.evaluate(() => {
    const bounds = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { movie: bounds('.movie-player'), faces: bounds('.people-strip'), tile: bounds('.face'), tiles: [...document.querySelectorAll('.people-strip .face')].map(face => ({ x: face.getBoundingClientRect().x, y: face.getBoundingClientRect().y })), microphone: bounds('.call-device-controls'), hangup: bounds('.hangup'), controls: bounds('.call-controls'), width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight };
  });
  assert.equal(landscape.movie.x, 0);
  assert.equal(landscape.movie.y, 0);
  assert.equal(landscape.movie.width, landscape.width);
  assert.equal(landscape.movie.height, landscape.height);
  assert.equal(landscape.width - landscape.controls.x - landscape.controls.width, 12);
  assert.equal(landscape.microphone.y, 12);
  assert.equal(landscape.height - landscape.hangup.y - landscape.hangup.height, 12);
  assert.ok(landscape.tiles[1].x > landscape.tiles[0].x);
  assert.equal(landscape.tiles[1].y, landscape.tiles[0].y);
  assert.equal(landscape.faces.x, 12);
  assert.ok(landscape.tile.height <= 64);
  assert.ok(Math.abs(landscape.height - landscape.faces.y - landscape.faces.height - 12) < 1);
  assert.ok(landscape.controls.height > landscape.controls.width * 3);
  assert.ok(Math.abs(landscape.tile.width / landscape.tile.height - 1.6) < 0.01);
  assert.equal(landscape.scrollWidth, landscape.width);
  assert.equal(landscape.scrollHeight, landscape.height);
  await screenshot('player-landscape');

  // A real autoplay refusal must hold the clock and use the ordinary transport
  // control. It must never paint a separate button over a running movie.
  await page.evaluate(() => {
    const video = document.querySelector('.movie-video');
    video.testNativePlay = video.play.bind(video);
    video.pause();
    let blocked = false;
    video.play = () => {
      if (!blocked) {
        blocked = true;
        // Deliver a previously queued playing event after the rejection's
        // catch handler, while the buffering broadcast is still in flight.
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => video.dispatchEvent(new Event('playing')))));
        return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
      }
      return video.testNativePlay();
    };
  });
  await page.getByRole('button', { name: 'Start playback', exact: true }).waitFor();
  assert.equal(await page.locator('.watch-prompt').count(), 0);
  await page.waitForFunction(async () => (await (await fetch('/api/session')).json()).state.waiting);
  const blockedPosition = party.currentPosition();
  await page.waitForTimeout(2200);
  assert.equal(party.currentPosition(), blockedPosition, 'An autoplay-blocked viewer cannot chase a moving timeline by seeking.');
  await page.evaluate(() => { window.testMissingMediaEvents = true; });
  await page.getByRole('button', { name: 'Start playback', exact: true }).click();
  await page.waitForFunction(playing);
  await page.waitForFunction(() => !document.querySelector('.playback-blocked'));
  await page.evaluate(() => { window.testMissingMediaEvents = false; const video = document.querySelector('.movie-video'); video.play = video.testNativePlay; });
  console.log('Mobile landscape fills the screen; real autoplay refusal holds the shared clock and resumes through the normal controls, without a movie overlay.');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.mouse.move(400, 300);
  await page.getByRole('button', { name: 'Fullscreen movie', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('app'));
  const overlay = await page.evaluate(() => {
    const movie = document.querySelector('.movie-video').getBoundingClientRect();
    const faces = document.querySelector('.people-strip').getBoundingClientRect();
    return { width: movie.width, height: movie.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
      right: Math.abs(innerWidth - faces.right - 16) < 2,
      top: Math.abs(faces.top - 16) < 2,
      inside: faces.left >= 0 && faces.right <= innerWidth };
  });
  assert.equal(overlay.width, overlay.viewportWidth);
  assert.equal(overlay.height, overlay.viewportHeight);
  assert.ok(overlay.right && overlay.top && overlay.inside);
  assert.equal(await page.locator('.people-strip .face').first().evaluate(face => face.getBoundingClientRect().width), 237);
  assert.ok(Math.abs(await page.locator('.people-strip .face').first().evaluate(face => face.getBoundingClientRect().height) - 237 / 1.6) < 1);
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.movie-controls')).opacity === '0', undefined, { timeout: 45000 });
  await screenshot('fullscreen-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('fullscreen-mobile');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => document.exitFullscreen());
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('Fullscreen fills the viewport and keeps the live call at the top right.');

  await post('control', { action: 'pause' });
  await page.waitForFunction(() => document.querySelector('.movie-video').paused);
  await page.evaluate(() => { const video = document.querySelector('.movie-video'); video.testNativePlay().catch(() => {}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('.movie-video').paused);
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.movie-video').evaluate(v => v.paused), true, 'A delayed play request must not resume a shared pause after a tab switch.');
  await post('control', { action: 'play' });
  await page.waitForFunction(playing);
  await page.mouse.move(400, 300);
  await page.getByRole('button', { name: 'Mute movie', exact: true }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.movie-controls')).opacity === '0', undefined, { timeout: 10000 });
  assert.equal(await page.locator('.movie-topline').evaluate(e => getComputedStyle(e).opacity), '0', 'Title overlay must hide after a pointer click too.');
  await page.mouse.move(450, 300);
  await page.getByRole('button', { name: 'Unmute movie', exact: true }).click();

  await post('control', { action: 'seek', position: 600 });
  await page.waitForFunction(() => document.querySelector('.movie-video')?.currentTime >= 600, undefined, { timeout: 45000 });
  if (movie.subtitles.some(track => !track.burn)) {
    const track = movie.subtitles.find(track => !track.burn);
    await page.getByLabel('Subtitles', { exact: true }).selectOption(track.id);
    await page.waitForFunction(() => [...document.querySelector('.movie-video').textTracks].some(track => track.mode === 'showing' && track.activeCues?.length > 0), undefined, { timeout: 45000 });
    assert.equal(await guest.getByLabel('Subtitles', { exact: true }).inputValue(), '');
    await screenshot('subtitles');
    await page.mouse.move(400, 300);
    await page.getByRole('button', { name: 'Fullscreen movie', exact: true }).click();
    await screenshot('fullscreen-subtitles');
    await page.evaluate(() => document.exitFullscreen());
    await page.getByLabel('Subtitles', { exact: true }).selectOption('');
    await page.waitForFunction(playing, undefined, { timeout: 45000 });
    assert.equal(await page.evaluate(() => [...document.querySelector('.movie-video').textTracks].some(track => track.mode === 'showing' && track.activeCues?.length > 0)), false);
    console.log('Plex text captions loaded as browser cues; viewer choice and Off work independently.');
  } else console.log('Text-caption check skipped: selected movie has no text tracks.');

  if (imageMovie) {
    await post('select', { id: imageMovie.id });
    await page.waitForFunction(playing, undefined, { timeout: 45000 });
    await guest.waitForFunction(playing, undefined, { timeout: 45000 });
    const transcodeEventsAt = playbackEvents.length;
    const track = imageMovie.subtitles.find(track => track.burn);
    let delayed = false;
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    await page.route('**/api/stream/**', async route => {
      if (!delayed) { delayed = true; await blocked; }
      await route.continue();
    });
    const result = page.waitForResponse(response => response.url().endsWith('/api/playback') && response.request().postDataJSON()?.subtitleId === track.id);
    await page.getByLabel('Subtitles', { exact: true }).selectOption(track.id);
    assert.equal((await (await result).json()).subtitleMode, 'burn');
    await page.waitForFunction(() => document.querySelector('.player-loading'));
    const state = () => page.evaluate(async () => (await (await fetch('/api/session')).json()).state);
    const held = await state();
    assert.ok(held.paused && held.waiting, 'Subtitle transcoding must hold the shared clock immediately.');
    await page.waitForTimeout(12000);
    const stillHeld = await state();
    assert.ok(delayed && stillHeld.paused && stillHeld.waiting, 'A slow transcode must not force playback after ten seconds.');
    assert.equal(stillHeld.position, held.position, 'The shared position must remain frozen while the transcoder catches up.');
    assert.ok(await guest.locator('.movie-video').evaluate(v => v.paused), 'The other viewer must wait too.');
    assert.equal(playbackEvents.slice(transcodeEventsAt).filter(sample => ['sync-recovery', 'seek-recovery', 'state-stale'].includes(sample.event)).length, 0, 'A legitimate twelve-second transcode hold must not trigger synchronization recovery loops.');
    assert.equal(playbackEvents.slice(transcodeEventsAt).filter(sample => sample.event === 'stream-start' && sample.viewer === 'owner').length, 1, 'The slow caption source must not be repeatedly replaced while it buffers.');
    release();
    await page.waitForFunction(playing, undefined, { timeout: 45000 });
    await guest.waitForFunction(playing, undefined, { timeout: 45000 });
    await page.unroute('**/api/stream/**');
    assert.ok(Math.abs(await page.locator('.movie-video').evaluate(v => v.currentTime) - await guest.locator('.movie-video').evaluate(v => v.currentTime)) < 1, 'Viewers must resume together after a slow transcode.');
    await assertSustainedSynchronization('Recovery after twelve-second caption transcode hold');
    assert.equal(playbackEvents.slice(transcodeEventsAt).filter(sample => ['sync-recovery', 'seek-recovery', 'state-stale'].includes(sample.event)).length, 0, 'Healthy recovered playback must not trigger automatic reload loops.');
    assert.equal(playbackEvents.slice(transcodeEventsAt).filter(sample => sample.event === 'stream-start' && sample.viewer === 'owner').length, 1, 'Caption recovery must retain its single replacement source.');
    assert.equal(await page.locator('.quality-label').textContent(), 'Optimized video');
    console.log('Plex image captions stayed synchronized through a twelve-second transcode delay and resumed within one second.');
  } else console.log('Image-caption check skipped: library has no image subtitle tracks.');

  const show = library.find(item => item.type === 'show');
  if (show) {
    let episodes = await plex.library({ parent: show.id });
    const season = episodes.find(item => item.type === 'season');
    if (season) episodes = await plex.library({ parent: season.id });
    const episode = episodes.find(item => item.type === 'episode');
    if (episode) {
      await post('select', { id: episode.id });
      const expected = `${episode.seriesTitle} · ${episode.title}`;
      await page.waitForFunction(title => document.querySelector('.movie-title strong')?.textContent === title, expected);
      assert.equal(await page.locator('.footer-content strong').textContent(), expected);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.locator('.movie-title strong').first().textContent(), expected);
      await page.mouse.move(150, 280);
      await screenshot('episode-mobile');
      assert.equal(await page.locator('.movie-title > span').textContent(), episode.episodeDetails);
      const lobbyContext = await browser.newContext();
      const lobby = await lobbyContext.newPage();
      await lobby.goto('http://localhost:5176');
      assert.equal(await lobby.locator('.joining-movie .series-name').textContent(), episode.seriesTitle);
      assert.equal(await lobby.locator('.joining-movie .episode-details').textContent(), episode.episodeDetails);
      await lobbyContext.close();
      console.log('Series, season and episode labels appear in the lobby and player.');
    }
  }
  await page.mouse.move(150, 280);
  await page.getByRole('button', { name: 'Stop movie', exact: true }).click();
  await page.waitForSelector('dialog.library[open]');
  await guest.waitForFunction(() => !document.querySelector('.movie-video'));
  assert.ok(await page.locator('.face video.visible').count() >= 2);
  assert.ok(await guest.locator('.face video.visible').count() >= 2);
  assert.equal(plex.streams.size, 0);
  assert.equal(await page.evaluate(() => window.testMediaRequests.length), 1);
  console.log('Stop returns the host to selection and clears guests’ playback without leaving the call.');
  assert.deepEqual(errors, []);
  await guest.getByRole('button', { name: 'Leave the call', exact: true }).click();
  await page.getByRole('button', { name: 'Close movie picker' }).click();
  await page.getByRole('button', { name: 'Leave the call', exact: true }).click();
} finally {
  await browser?.close();
  for (const id of [...plex.streams.keys()]) await plex.stop(id);
  await close();
}
