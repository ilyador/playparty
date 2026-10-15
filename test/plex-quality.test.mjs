import test from 'node:test';
import assert from 'node:assert/strict';
import { Plex } from '../server/plex.mjs';

function fixture() {
  const plex = new Plex({ token: 'fixture-token' });
  const requests = [];
  plex.metadata = async () => ({ Media: [{ videoCodec: 'hevc', Part: [{ key: '/media/fixture', Stream: [
    { id: '9', streamType: 3, codec: 'pgs' },
  ] }] }] });
  plex.stop = async () => {};
  plex.request = async () => new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\nindex.m3u8\n');
  plex.json = async path => {
    const url = new URL(path, plex.url);
    requests.push(url);
    return { Metadata: [{ Media: [{ Part: [{ Stream: [{ streamType: 1, decision: 'transcode' }] }] }] }] };
  };
  return { plex, requests };
}

test('local compatible playback removes bitrate ceilings and ignores remote quality requests', async () => {
  const { plex, requests } = fixture();
  await plex.start('local-guest', { id: '1', version: 2 }, { remote: false, adaptive: true, maxBitrate: 1500, hevc: true });
  const params = requests[0].searchParams;
  assert.equal(params.get('location'), 'lan');
  assert.equal(params.has('maxVideoBitrate'), false);
  assert.equal(params.has('videoBitrate'), false);
  assert.equal(params.get('videoResolution'), '3840x2160');
  assert.match(params.get('X-Plex-Client-Profile-Extra'), /videoCodec=h264,hevc/);
});

test('only reduced remote streams constrain resolution, using per-session parameters', async () => {
  const { plex, requests } = fixture();
  for (const [maxBitrate, expected] of [[1500, '1280x720'], [4000, '1280x720'], [8000, '1920x1080'], [20000, '3840x2160']]) {
    await plex.start('remote-guest', { id: '1', version: 2 }, { remote: true, adaptive: true, maxBitrate });
    const url = requests.at(-1);
    assert.equal(url.pathname, '/video/:/transcode/universal/decision');
    assert.equal(url.searchParams.get('location'), 'wan');
    assert.equal(url.searchParams.get('maxVideoBitrate'), String(maxBitrate));
    assert.equal(url.searchParams.get('videoResolution'), expected);
    const stream = plex.streams.get('remote-guest');
    const start = new URL(plex.resources.get([...stream.resourceIds][0]).target, plex.url);
    assert.deepEqual([...start.searchParams], [...url.searchParams]);
  }
});

test('initial quality and subtitles preserve browser codec negotiation and timeline parameters', async () => {
  const { plex, requests } = fixture();
  const result = await plex.start('remote-guest', { id: '1', version: 2 }, { remote: true, maxBitrate: 8000, position: 123, subtitleId: '9' });
  const params = requests[0].searchParams;
  assert.equal(params.get('videoResolution'), '3840x2160');
  assert.equal(params.get('offset'), '123');
  assert.equal(params.get('copyts'), '1');
  assert.equal(result.offset, 0);
  assert.equal(params.get('subtitles'), 'burn');
  assert.equal(params.get('subtitleStreamID'), '9');
  assert.match(params.get('X-Plex-Client-Profile-Extra'), /videoCodec=h264&audioCodec=aac/);
  assert.equal(result.quality, 'Optimized video');
});

test('decoder recovery asks Plex to encode independently while preserving the selected quality', async () => {
  const { plex, requests } = fixture();
  await plex.start('original', { id: '1', version: 2 }, { remote: true, maxBitrate: 59500, hevc: true });
  const original = requests.at(-1).searchParams;
  await plex.start('recovery', { id: '1', version: 2 }, { remote: true, maxBitrate: 59500, hevc: true, forceTranscode: true });
  const recovered = requests.at(-1).searchParams;
  assert.equal(original.get('directStream'), '1');
  assert.equal(recovered.get('directStream'), '0');
  for (const key of ['videoBitrate', 'maxVideoBitrate', 'videoResolution', 'videoQuality', 'X-Plex-Client-Profile-Extra']) {
    assert.equal(recovered.get(key), original.get(key), 'Encoding recovery cannot lower the requested quality or change codec support.');
  }

  await plex.start('local-recovery', { id: '1', version: 2 }, { remote: false, maxBitrate: 1500, adaptive: true, forceTranscode: true });
  const local = requests.at(-1).searchParams;
  assert.equal(local.get('directStream'), '0');
  assert.equal(local.get('location'), 'lan');
  assert.equal(local.has('maxVideoBitrate'), false);
  assert.equal(local.has('videoBitrate'), false);
  assert.equal(local.get('videoResolution'), '3840x2160');
});
