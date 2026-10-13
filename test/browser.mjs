// Real Plex/LiveKit integration, using an isolated server and fake camera/mic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
const testOwner = randomUUID();
const { server } = createApp({ plex, authenticateOwner: header => cookies(header).test_owner === testOwner,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitUrl: 'ws://localhost:7880', origin: 'http://localhost:5176', movieMbps: 70, roomName: `playparty-test-${randomUUID()}`, recordProgress: false });
await new Promise(resolve => server.listen(5176, '127.0.0.1', resolve));
let browser;
const output = '.impeccable/review';
if (process.env.TEST_CAPTURE === '1') fs.mkdirSync(output, { recursive: true });
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const playing = () => { const v = document.querySelector('.movie-video'); return v && v.readyState >= 3 && v.currentTime > 2 && !v.paused; };
const instrument = () => {
  const Native = window.RTCPeerConnection;
  window.testPeers = [];
  window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.testPeers.push(this); } };
};
try {
  const library = await plex.library();
  const movies = library.filter(item => item.type === 'movie');
  assert.ok(movies.length, 'The Plex library must contain a movie.');
  const details = await Promise.all(movies.slice(0, 30).map(async item => plex.simplify(await plex.metadata(item.id))));
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
  console.log('Real movie playback and host camera/microphone connected.');

  const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await guestContext.addInitScript(instrument);
  const guest = await guestContext.newPage();
  guest.on('pageerror', error => errors.push(error.message));
  await guest.goto('http://localhost:5176');
  await guest.locator('#name').fill('Test Guest');
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await guest.waitForFunction(playing, undefined, { timeout: 45000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.face video.visible')].length >= 2, undefined, { timeout: 25000 });
  const media = await page.evaluate(async () => {
    const tracks = [];
    for (const pc of window.testPeers) for (const stat of (await pc.getStats()).values())
      if (stat.type === 'inbound-rtp') tracks.push({ kind: stat.kind, bytes: stat.bytesReceived, frames: stat.framesDecoded });
    return tracks;
  });
  assert.ok(media.some(track => track.kind === 'video' && track.frames > 0));
  assert.ok(media.some(track => track.kind === 'audio' && track.bytes > 0));

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
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.movie-controls')).opacity === '0', undefined, { timeout: 10000 });
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
    const result = page.waitForResponse(response => response.url().endsWith('/api/playback') && response.request().postDataJSON()?.subtitleId === track.id);
    await page.getByLabel('Subtitles', { exact: true }).selectOption(track.id);
    assert.equal((await (await result).json()).subtitleMode, 'burn');
    await page.waitForFunction(playing, undefined, { timeout: 45000 });
    assert.equal(await page.locator('.quality-label').textContent(), 'Optimized video');
    console.log('Plex image captions use converted video and remain playable.');
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
  console.log('Stop returns the host to selection and clears guests’ playback without leaving the call.');
  assert.deepEqual(errors, []);
  await guest.getByRole('button', { name: 'Leave the call', exact: true }).click();
  await page.getByRole('button', { name: 'Close movie picker' }).click();
  await page.getByRole('button', { name: 'Leave the call', exact: true }).click();
} finally {
  await browser?.close();
  for (const id of [...plex.streams.keys()]) await plex.stop(id);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
