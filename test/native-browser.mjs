// Real Plex captions in WebKit, isolated from the normal room and watch history.
// The default covers WebKit's normal Hls.js / MSE path. TEST_NATIVE=1 enables
// Linux WebKit's opt-in native HLS backend and hides MSE only to exercise the
// player's native fallback. Playback, cues, and canPlayType are not mocked.
// This Linux backend did not expose Plex HLS WebVTT tracks in integration
// testing. An opt-in native run requires real cues; it does not validate iOS.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { webkit } from 'playwright';
import { createApp } from '../server/index.mjs';
import { Plex } from '../server/plex.mjs';
import { cookies } from '../server/auth.mjs';

const native = process.env.TEST_NATIVE === '1';
const playbackTimeout = Number(process.env.TEST_NATIVE_TIMEOUT || 35000);
const port = Number(process.env.TEST_NATIVE_PORT || 5178);
const origin = `http://localhost:${port}`;
const testOwner = randomUUID();
const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN });
// Start this isolated party at zero without changing stored Plex progress.
const simplify = plex.simplify.bind(plex);
plex.simplify = item => ({ ...simplify(item), resumePosition: 0 });
const playbackModes = [];
const manifestSubtitles = [];
const rewritePlaylist = plex.rewritePlaylist.bind(plex);
plex.rewritePlaylist = (text, base, stream) => {
  const tracks = text.split('\n').filter(line => line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=SUBTITLES'));
  if (tracks.length) manifestSubtitles.push({ renditions: tracks.length, defaultYes: tracks.filter(line => line.includes('DEFAULT=YES')).length });
  return rewritePlaylist(text, base, stream);
};
const { server, close } = createApp({ plex,
  authenticateOwner: header => cookies(header).test_owner === testOwner,
  livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
  livekitUrl: 'ws://localhost:7880', origin, movieMbps: 70,
  roomName: `playparty-native-test-${randomUUID()}`, recordProgress: false,
  logPlayback: sample => { if (sample.event === 'stream-start') playbackModes.push(sample.subtitleMode); },
  assetsRoot: process.env.TEST_BUILD_DIR ? path.resolve(process.env.TEST_BUILD_DIR) : undefined,
});
let browser;
let page;
let phase = 'platform';
let capability;
const streamResponses = {};
server.on('request', (request, response) => {
  if (request.url?.startsWith('/api/stream/')) response.once('finish', () => {
    streamResponses[response.statusCode] = (streamResponses[response.statusCode] || 0) + 1;
  });
});
const numericState = () => {
  const video = document.querySelector('.movie-video');
  if (!video) return { present: false };
  return { present: true, readyState: video.readyState, paused: video.paused,
    currentTime: Math.round(video.currentTime * 1000) / 1000,
    duration: Number.isFinite(video.duration) ? video.duration : String(video.duration),
    width: video.videoWidth, height: video.videoHeight,
    decodedFrames: video.getVideoPlaybackQuality?.().totalVideoFrames || video.webkitDecodedFrameCount || 0,
    mediaError: video.error?.code || 0, mseSource: video.currentSrc.startsWith('blob:'),
    buffered: Array.from({ length: video.buffered.length }, (_, index) => ({ start: video.buffered.start(index), end: video.buffered.end(index) })),
    tracks: [...video.textTracks].map(track => ({ kind: track.kind, mode: track.mode,
      cues: track.cues?.length || 0, active: track.activeCues?.length || 0,
      activeTimes: [...(track.activeCues || [])].map(cue => ({ start: cue.startTime, end: cue.endTime })) })) };
};
const playing = () => {
  const video = document.querySelector('.movie-video');
  return video?.readyState >= 3 && video.currentTime > 2 && !video.paused;
};
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  browser = await webkit.launch({ headless: true,
    env: { ...process.env, WEBKIT_GST_ENABLE_HLS_SUPPORT: native ? '1' : '0' } });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'test_owner', value: testOwner, url: origin }]);
  await context.addInitScript(({ native }) => {
    // This test does not access the machine's physical camera or microphone.
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Test devices denied', 'NotAllowedError'); };
    if (native) {
      Object.defineProperty(window, 'MediaSource', { value: undefined, configurable: true });
      Object.defineProperty(window, 'ManagedMediaSource', { value: undefined, configurable: true });
      Object.defineProperty(window, 'WebKitMediaSource', { value: undefined, configurable: true });
    }
  }, { native });
  page = await context.newPage();
  let pageErrors = 0;
  page.on('pageerror', () => { pageErrors += 1; });
  await page.goto(origin);
  await page.addScriptTag({ path: path.resolve('node_modules/hls.js/dist/hls.js') });
  capability = await page.evaluate(() => ({ nativeHls: document.createElement('video').canPlayType('application/vnd.apple.mpegurl'), hlsJs: Hls.isSupported() }));
  console.log(JSON.stringify({ engine: 'WebKit', path: native ? 'native-HLS' : 'Hls.js', capability }));
  assert.ok(native ? capability.nativeHls && !capability.hlsJs : capability.hlsJs, 'The requested playback engine must be available.');
  phase = 'library';
  const library = await plex.library();
  let movie;
  let subtitle;
  for (const candidate of library.filter(item => item.type === 'movie').slice(0, 30)) {
    const metadata = await plex.metadata(candidate.id);
    const stream = (metadata.Media?.[0]?.Part?.[0]?.Stream || []).find(track => Number(track.streamType) === 3 && String(track.codec).toLowerCase() === 'srt');
    if (stream) { movie = plex.simplify(metadata); subtitle = String(stream.id); break; }
  }
  assert.ok(movie && subtitle, 'A movie with an SRT text subtitle is required.');
  const post = (route, body = {}) => page.evaluate(async ({ route, body }) => {
    const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Isolated test API request failed.');
    return response.json();
  }, { route, body });
  phase = 'join';
  await page.locator('#name').fill('Native Test Host');
  await page.getByRole('switch', { name: 'I am the host' }).check();
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByRole('button', { name: 'Leave the call', exact: true }).waitFor();
  phase = 'playback';
  await post('select', { id: movie.id });
  await page.locator('.movie-video').waitFor();
  await page.waitForFunction(playing, undefined, { timeout: playbackTimeout }).catch(async error => {
    if (await page.getByRole('button', { name: 'Tap to watch', exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Tap to watch', exact: true }).click();
      await page.waitForFunction(playing, undefined, { timeout: playbackTimeout });
    } else throw error;
  });
  const initialMedia = await page.evaluate(numericState);
  assert.equal(initialMedia.mseSource, !native, 'Playback must use the requested actual media engine.');
  assert.ok(initialMedia.width > 0 && initialMedia.height > 0 && initialMedia.decodedFrames > 0, 'The actual video decoder must produce frames.');
  phase = 'captions';
  await page.getByLabel('Subtitles', { exact: true }).selectOption(subtitle);
  const seekPositions = [Math.min(600, movie.duration * 0.25), Math.min(1200, movie.duration * 0.5)];
  for (const position of seekPositions) {
    await post('control', { action: 'seek', position: Math.floor(position) });
    await page.waitForFunction(() => {
      const video = document.querySelector('.movie-video');
      return video && !video.paused && [...video.textTracks].some(track => track.mode === 'showing' && track.activeCues?.length > 0);
    }, undefined, { timeout: 45000 });
    const sample = await page.evaluate(numericState);
    assert.ok(sample.currentTime >= Math.floor(position) - 1, 'Playback must reach the shared seek position.');
    assert.ok(sample.tracks.some(track => track.mode === 'showing' && track.activeTimes.some(cue => cue.start <= sample.currentTime + 0.25 && cue.end >= sample.currentTime - 0.25)), 'Active cues must match the actual playback clock after seeking.');
    assert.equal(sample.mseSource, !native);
    assert.ok(sample.decodedFrames > 0, 'The caption sample must be backed by actual decoded video.');
    console.log(JSON.stringify({ engine: 'WebKit', path: native ? 'native-HLS' : 'Hls.js', seek: Math.floor(position), ...sample }));
  }
  phase = 'off';
  await page.getByLabel('Subtitles', { exact: true }).selectOption('');
  await page.waitForFunction(playing, undefined, { timeout: 35000 });
  assert.equal(await page.evaluate(() => [...document.querySelector('.movie-video').textTracks].some(track => track.mode === 'showing' && track.activeCues?.length)), false, 'Off must hide captions.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'The mobile viewport must not overflow.');
  assert.equal(pageErrors, 0, 'The browser must not report uncaught application errors.');
  phase = 'leave';
  await post('stop');
  const closePicker = page.getByRole('button', { name: 'Close movie picker' });
  if (await closePicker.isVisible()) await closePicker.click();
  await page.getByRole('button', { name: 'Leave the call', exact: true }).click();
  console.log(JSON.stringify({ engine: 'WebKit', path: native ? 'native-HLS' : 'Hls.js', result: 'pass', pageErrors, streamResponses, playbackModes, manifestSubtitles }));
} catch (error) {
  // Keep private movie titles, subtitle text, stream URLs and credentials out of logs.
  const shared = page ? await page.evaluate(async () => {
    const { state } = await (await fetch('/api/session')).json();
    return { paused: state.paused, waiting: state.waiting, position: state.position };
  }).catch(() => ({ unavailable: true })) : {};
  console.log(JSON.stringify({ engine: 'WebKit', path: native ? 'native-HLS' : 'Hls.js', result: 'failed', phase, errorType: error.name, shared, streamResponses, playbackModes, manifestSubtitles,
    ...(page ? { media: await page.evaluate(numericState).catch(() => ({ unavailable: true })) } : {}) }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const identity of [...plex.streams.keys()]) await plex.stop(identity);
  await close();
}
