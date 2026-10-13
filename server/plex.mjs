import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false });
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];

export class Plex {
  constructor({ url = 'http://127.0.0.1:32400', preferences, token, ownerEmail } = {}) {
    this.url = new URL(url);
    const prefs = preferences && fs.existsSync(preferences) ? xml.parse(fs.readFileSync(preferences, 'utf8')).Preferences : {};
    this.token = token || prefs?.PlexOnlineToken;
    this.ownerEmail = (ownerEmail || prefs?.PlexOnlineMail)?.trim().toLowerCase();
    this.ownerName = prefs?.PlexOnlineUsername || 'Host';
    this.resources = new Map();
    this.streams = new Map();
    if (!this.token) throw new Error('Plex credentials are unavailable. Set PLEX_PREFERENCES or PLEX_TOKEN.');
  }

  headers(identity = 'playparty') {
    return {
      'X-Plex-Token': this.token,
      'X-Plex-Client-Identifier': identity,
      'X-Plex-Product': 'Playparty',
      'X-Plex-Version': '0.1.0',
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Pms-Api-Version': '1.2.3',
      Accept: 'application/json',
    };
  }

  async request(path, identity, options = {}) {
    const response = await fetch(new URL(path, this.url), {
      ...options,
      headers: { ...this.headers(identity), ...options.headers },
      signal: options.signal || AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Object.assign(new Error(`Plex returned ${response.status}.`), { status: 502 });
    return response;
  }

  async json(path, identity, options) {
    return (await (await this.request(path, identity, options)).json()).MediaContainer || {};
  }

  simplify(item) {
    return {
      id: String(item.ratingKey),
      title: item.title,
      year: item.year,
      type: item.type,
      duration: (Number(item.duration) || 0) / 1000,
      summary: item.summary || '',
      episodeTitle: item.type === 'episode' ? `${item.grandparentTitle} · S${item.parentIndex} E${item.index}` : undefined,
      seriesTitle: item.type === 'episode' ? item.grandparentTitle : undefined,
      episodeNumber: item.type === 'episode' ? `S${item.parentIndex} E${item.index}` : undefined,
      episodeDetails: item.type === 'episode' ? `Season ${item.parentIndex} · Episode ${item.index}` : undefined,
      resumePosition: Math.max(0, Number(item.viewOffset) || 0) / 1000,
      lastPlayedAt: Number(item.lastViewedAt) || 0,
      subtitles: this.subtitleTracks(item),
      resolution: item.Media?.[0]?.videoResolution,
      hasPoster: Boolean(item.thumb || item.parentThumb || item.grandparentThumb),
    };
  }

  subtitleTracks(item) {
    return array(array(array(item.Media)[0]?.Part)[0]?.Stream)
      .filter(track => Number(track.streamType) === 3 && track.id != null)
      .map(track => ({
        id: String(track.id),
        label: [track.displayTitle || track.language || track.languageCode || 'Unknown language', track.title].filter(Boolean).join(' · '),
        burn: ['pgs', 'vobsub', 'dvd_subtitle', 'dvb_subtitle', 'hdmv_pgs_subtitle'].includes(String(track.codec).toLowerCase()),
      }));
  }

  async library({ query = '', parent = '' } = {}) {
    if (parent) {
      if (!/^\d+$/.test(parent)) throw Object.assign(new Error('Invalid content.'), { status: 400 });
      const data = await this.json(`/library/metadata/${parent}/children`);
      return array(data.Metadata).map(item => this.simplify(item));
    }
    if (query.trim()) {
      const data = await this.json(`/hubs/search?query=${encodeURIComponent(query.trim())}&limit=60&includeCollections=0`);
      return array(data.Hub).flatMap(hub => array(hub.Metadata))
        .filter(item => ['movie', 'show', 'episode'].includes(item.type)).map(item => this.simplify(item));
    }
    const sections = await this.json('/library/sections');
    const libraries = array(sections.Directory).filter(section => ['movie', 'show'].includes(section.type));
    const items = await Promise.all(libraries.map(async section => {
      const data = await this.json(`/library/sections/${section.key}/all?sort=titleSort&X-Plex-Container-Start=0&X-Plex-Container-Size=250`);
      return array(data.Metadata).map(item => this.simplify(item));
    }));
    return items.flat();
  }

  async metadata(id) {
    if (!/^\d+$/.test(String(id))) throw Object.assign(new Error('Invalid content.'), { status: 400 });
    const data = await this.json(`/library/metadata/${id}`);
    const item = array(data.Metadata)[0];
    if (!item) throw Object.assign(new Error('This item is no longer in Plex.'), { status: 404 });
    return item;
  }

  async continueWatching() {
    const [data, sections] = await Promise.all([
      this.json('/hubs/continueWatching?X-Plex-Container-Start=0&X-Plex-Container-Size=30'), this.json('/library/sections'),
    ]);
    const recent = await Promise.all(array(sections.Directory).filter(section => ['movie', 'show'].includes(section.type)).map(async section => {
      const result = await this.json(`/library/sections/${section.key}/all?type=${section.type === 'show' ? 4 : 1}&sort=lastViewedAt:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=20`);
      return array(result.Metadata).filter(item => Number(item.viewOffset) > 0);
    }));
    const items = [...recent.flat(), ...array(data.Metadata), ...array(data.Hub).flatMap(hub => array(hub.Metadata))];
    const unique = new Map();
    for (const item of items) if (['movie', 'episode'].includes(item.type) && !unique.has(String(item.ratingKey))) unique.set(String(item.ratingKey), this.simplify(item));
    return [...unique.values()].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
  }

  async timeline(movie, position, state, session) {
    const params = new URLSearchParams({
      ratingKey: movie.id, key: `/library/metadata/${movie.id}`, identifier: 'com.plexapp.plugins.library',
      state, time: String(Math.round(Math.max(0, position) * 1000)), duration: String(Math.round(movie.duration * 1000)),
    });
    const response = await this.request(`/:/timeline?${params}`, 'playparty-progress', {
      method: 'POST', headers: { 'X-Plex-Session-Identifier': session }, signal: AbortSignal.timeout(5000),
    });
    await response.arrayBuffer();
  }

  async image(id, kind = 'thumb') {
    const item = await this.metadata(id);
    const source = kind === 'art' ? item.art || item.grandparentArt : item.thumb || item.parentThumb || item.grandparentThumb;
    if (!source) throw Object.assign(new Error('No artwork.'), { status: 404 });
    const path = `/photo/:/transcode?${new URLSearchParams({ url: source, width: kind === 'art' ? '1600' : '320', height: kind === 'art' ? '900' : '480', minSize: '1', upscale: '0' })}`;
    return this.request(path);
  }

  addResource(stream, target) {
    const parsed = new URL(target, this.url);
    if (parsed.origin !== this.url.origin) throw new Error('Unexpected Plex stream destination.');
    parsed.searchParams.delete('X-Plex-Token');
    parsed.searchParams.delete('x-plex-token');
    const targetPath = parsed.pathname + parsed.search;
    const existing = stream.targets.get(targetPath);
    if (existing) return `/api/stream/${existing}`;
    const id = randomUUID();
    this.resources.set(id, { streamId: stream.id, target: targetPath });
    stream.targets.set(targetPath, id);
    stream.resourceIds.add(id);
    return `/api/stream/${id}`;
  }

  rewritePlaylist(text, base, stream) {
    const resource = uri => this.addResource(stream, new URL(uri, base).toString());
    return text.split('\n').map(line => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${resource(uri)}"`);
      return resource(line.trim());
    }).join('\n');
  }

  async stop(identity) {
    const old = this.streams.get(identity);
    if (!old) return;
    this.streams.delete(identity);
    for (const id of old.resourceIds) this.resources.delete(id);
    await fetch(new URL(`/video/:/transcode/universal/stop?session=${encodeURIComponent(old.session)}`, this.url), {
      headers: this.headers(`playparty-${identity}`), signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }

  async transcodeMetrics(identity) {
    const stream = this.streams.get(identity);
    if (!stream) return { available: false };
    const data = await this.json('/transcode/sessions', undefined, { signal: AbortSignal.timeout(3000) });
    const row = array(data.TranscodeSession).find(item => item.id === stream.session || String(item.key || '').includes(stream.session));
    if (!row) return { available: false };
    return { available: true, speed: Number(row.speed) || 0, progress: Number(row.progress) || 0,
      throttled: row.throttled === true || row.throttled === '1', hardware: Boolean(row.transcodeHwEncoding && row.transcodeHwEncoding !== '0'),
      videoDecision: ['copy', 'transcode'].includes(row.videoDecision) ? row.videoDecision : 'unknown' };
  }

  async start(identity, movie, { position = 0, hevc = false, maxBitrate = 50000, subtitleId = '', remote, adaptive = false } = {}) {
    const item = await this.metadata(movie.id);
    const subtitle = this.subtitleTracks(item).find(track => track.id === subtitleId);
    if (subtitleId && !subtitle) throw Object.assign(new Error('This subtitle track is unavailable. Choose another track.'), { status: 400 });
    await this.stop(identity);
    const media = array(item.Media)[0];
    const part = array(media?.Part)[0];
    if (!part?.key) throw new Error('Plex could not find this media file.');
    const client = `playparty-${identity}`;
    const session = `playparty-${randomUUID()}`;
    const stream = { id: randomUUID(), identity, session, resourceIds: new Set(), targets: new Map(), version: movie.version };
    this.streams.set(identity, stream);
    const codecs = hevc ? 'h264,hevc' : 'h264';
    const bitrate = Number.isFinite(maxBitrate) ? Math.max(1500, Math.floor(maxBitrate)) : 50000;
    const reducedResolution = remote !== false && adaptive;
    const resolution = reducedResolution && bitrate <= 4000 ? '1280x720' : reducedResolution && bitrate <= 12000 ? '1920x1080' : '3840x2160';
    const params = new URLSearchParams({
      path: `/library/metadata/${movie.id}`, mediaIndex: '0', partIndex: '0',
      protocol: 'hls', directPlay: '0', directStream: '1', directStreamAudio: '1',
      hasMDE: '1', location: remote === false ? 'lan' : 'wan', fastSeek: '1', offset: String(Math.max(0, position)),
      session, 'X-Plex-Session-Identifier': session, transcodeSessionId: session,
      ...(remote === false ? {} : { videoBitrate: String(bitrate), maxVideoBitrate: String(bitrate) }),
      videoResolution: resolution, videoQuality: '100', audioBoost: '100',
      subtitles: subtitle ? subtitle.burn ? 'burn' : 'segmented' : 'none',
      ...(subtitle ? { subtitleStreamID: subtitle.id, advancedSubtitles: subtitle.burn ? 'burn' : 'text' } : {}),
      copyts: '1', secondsPerSegment: '2',
      'X-Plex-Client-Profile-Name': 'generic',
      'X-Plex-Client-Profile-Extra': `add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mp4&videoCodec=${codecs}&audioCodec=aac&replace=true)+add-direct-play-profile(type=videoProfile&container=mp4,mkv&videoCodec=${codecs}&audioCodec=aac&subtitleCodec=webvtt)+add-transcode-target(type=subtitleProfile&context=all&protocol=hls&container=webvtt&subtitleCodec=webvtt)${hevc ? '+add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.bitDepth&value=10&replace=true)+add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.level&value=186&replace=true)' : ''}`,
    });
    try {
      const decision = await this.json(`/video/:/transcode/universal/decision?${params}`, client);
      const chosen = array(decision.Metadata)[0]?.Media?.[0];
      const tracks = array(chosen?.Part?.[0]?.Stream);
      const video = tracks.find(track => Number(track.streamType) === 1);
      stream.diagnostics = { videoDecision: video?.decision, inputCodec: media?.videoCodec, maxBitrate: remote === false ? 0 : bitrate };
      const start = new URL(`/video/:/transcode/universal/start.m3u8?${params}`, this.url);
      return {
        url: this.addResource(stream, start.toString()),
        offset: 0,
        quality: video?.decision === 'copy' ? 'Original video' : 'Optimized video',
        resolution: chosen?.videoResolution || movie.resolution || '',
        kind: 'hls',
        subtitleMode: subtitle ? subtitle.burn ? 'burn' : 'segmented' : 'none',
      };
    } catch (error) {
      await this.stop(identity);
      throw error;
    }
  }
}
