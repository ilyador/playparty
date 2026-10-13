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
const { server, close } = createApp({ plex, authenticateOwner: header => cookies(header).test_owner === testOwner,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitUrl: 'ws://localhost:7880', origin: 'http://localhost:5176', movieMbps: 70, roomName: `playparty-test-${randomUUID()}`, recordProgress: false,
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined });
await new Promise(resolve => server.listen(5176, '127.0.0.1', resolve));
let browser;
const output = '.impeccable/review';
if (process.env.TEST_CAPTURE === '1') fs.mkdirSync(output, { recursive: true });
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const playing = () => { const v = document.querySelector('.movie-video'); return v && v.readyState >= 3 && v.currentTime > 2 && !v.paused; };
const instrument = () => {
  const Native = window.RTCPeerConnection;
  window.testPeers = [];
  window.testMediaRequests = [];
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
  console.log('Real movie playback and a single camera/microphone request with echo cancellation connected.');

  const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await guestContext.addInitScript(instrument);
  const guest = await guestContext.newPage();
  guest.on('pageerror', error => errors.push(error.message));
  await guest.goto('http://localhost:5176');
  await guest.locator('#name').fill('Test Guest');
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await guest.waitForFunction(playing, undefined, { timeout: 45000 });
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

  // A browser can reject one autoplay attempt, then start playback through a
  // different path. The prompt must follow actual playback, not that old error.
  await page.evaluate(() => {
    const video = document.querySelector('.movie-video');
    video.testNativePlay = video.play.bind(video);
    video.pause();
    let blocked = false;
    video.play = () => {
      if (!blocked) { blocked = true; return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError')); }
      return video.testNativePlay();
    };
  });
  await page.getByRole('button', { name: 'Tap to watch', exact: true }).waitFor();
  await page.evaluate(() => document.querySelector('.movie-video').testNativePlay());
  await page.waitForFunction(playing);
  await page.waitForFunction(() => !document.querySelector('.watch-prompt'));
  await page.evaluate(() => { const video = document.querySelector('.movie-video'); video.play = video.testNativePlay; });
  console.log('Mobile landscape fills the screen, overlays a horizontal 16:10 call row, and splits right-edge controls; a stale autoplay prompt clears on playback.');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.mouse.move(400, 300);
  await page.getByRole('button', { name: 'Fullscreen movie', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('app'));
  const overlay = await page.evaluate(() => {
    const movie = document.querySelector('.movie-video').getBoundingClientRect();
    const faces = document.querySelector('.people-strip').getBoundingClientRect();
    return { width: movie.width, height: movie.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
      centered: Math.abs(faces.left + faces.width / 2 - innerWidth / 2) < 2,
      bottom: faces.top > innerHeight / 2 && faces.bottom < innerHeight,
      inside: faces.left >= 0 && faces.right <= innerWidth };
  });
  assert.equal(overlay.width, overlay.viewportWidth);
  assert.equal(overlay.height, overlay.viewportHeight);
  assert.ok(overlay.centered && overlay.bottom && overlay.inside);
  assert.equal(await page.locator('.people-strip .face').first().evaluate(face => face.getBoundingClientRect().width), 237);
  assert.equal(await page.locator('.people-strip .face').first().evaluate(face => face.getBoundingClientRect().height), 180);
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.movie-controls')).opacity === '0', undefined, { timeout: 45000 });
  await screenshot('fullscreen-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('fullscreen-mobile');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => document.exitFullscreen());
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('Fullscreen fills the viewport and keeps the live call centered over the movie.');

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
    release();
    await page.waitForFunction(playing, undefined, { timeout: 45000 });
    await guest.waitForFunction(playing, undefined, { timeout: 45000 });
    await page.unroute('**/api/stream/**');
    assert.ok(Math.abs(await page.locator('.movie-video').evaluate(v => v.currentTime) - await guest.locator('.movie-video').evaluate(v => v.currentTime)) < 1, 'Viewers must resume together after a slow transcode.');
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
