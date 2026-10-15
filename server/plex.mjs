import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false });
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];

export class Plex {
  constructor({ url = 'http://127.0.0.1:32400', preferences, token } = {}) {
    this.url = new URL(url);
    const prefs = preferences && fs.existsSync(preferences) ? xml.parse(fs.readFileSync(preferences, 'utf8')).Preferences : {};
    this.token = token || prefs?.PlexOnlineToken;
    this.resources = new Map();
    this.streams = new Map();
    this.producers = new Map();
    this.pendingStarts = new Map();
  }

  headers(identity = 'playparty') {
    return {
      ...(this.token ? { 'X-Plex-Token': this.token } : {}),
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
    if (!response.ok) throw Object.assign(new Error(`Plex returned ${response.status}.`), { status: 502, upstreamStatus: response.status });
    return response;
  }

  async json(path, identity, options) {
    return (await (await this.request(path, identity, options)).json()).MediaContainer || {};
  }

  async canAccess() {
    try {
      const response = await this.request('/library/sections', undefined, { signal: AbortSignal.timeout(3000) });
      const container = (await response.json())?.MediaContainer;
      return Boolean(container && typeof container === 'object' && !Array.isArray(container));
    } catch { return false; }
  }

  simplify(item) {
    return {
      id: String(item.ratingKey),
      title: item.title,
      year: item.year,
      type: item.type,
      duration: (Number(item.duration) || 0) / 1000,
      episodeTitle: item.type === 'episode' ? `${item.grandparentTitle} · S${item.parentIndex} E${item.index}` : undefined,
      seriesTitle: item.type === 'episode' ? item.grandparentTitle : undefined,
      episodeNumber: item.type === 'episode' ? `S${item.parentIndex} E${item.index}` : undefined,
      episodeDetails: item.type === 'episode' ? `Season ${item.parentIndex} · Episode ${item.index}` : undefined,
      resumePosition: Math.max(0, Number(item.viewOffset) || 0) / 1000,
      lastPlayedAt: Number(item.lastViewedAt) || 0,
      subtitles: this.subtitleTracks(item),
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

  async metadata(id, options) {
    if (!/^\d+$/.test(String(id))) throw Object.assign(new Error('Invalid content.'), { status: 400 });
    const data = await this.json(`/library/metadata/${id}`, undefined, options);
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
    if (stream.released || stream.retired || stream.producer?.retired) throw Object.assign(new Error('The stream expired. Reconnect to watch.'), { status: 410 });
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
    if (stream.released || stream.retired || stream.producer?.retired) throw Object.assign(new Error('The stream expired. Reconnect to watch.'), { status: 410 });
    const resource = uri => this.addResource(stream, new URL(uri, base).toString());
    return text.split('\n').map(line => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${resource(uri)}"`);
      return resource(line.trim());
    }).join('\n');
  }

  cancelStart(pending) {
    if (!pending) return;
    pending.cancelled = true;
    pending.abort.abort();
    if (pending.provisional) return this.release(pending.assignment);
  }

  async release(assignment) {
    if (!assignment || assignment.released) return;
    assignment.released = true;
    if (this.streams.get(assignment.identity) === assignment) this.streams.delete(assignment.identity);
    assignment.producer.leases.delete(assignment);
    if (!assignment.producer.leases.size) await this.invalidate(assignment);
  }

  async stop(identity, expected) {
    if (arguments.length > 1) return this.release(expected);
    const pending = this.pendingStarts.get(identity);
    this.pendingStarts.delete(identity);
    await Promise.all([this.cancelStart(pending), this.release(this.streams.get(identity))]);
  }

  invalidate(stream) {
    const producer = stream?.producer || stream;
    if (!producer) return Promise.resolve();
    if (producer.retired) return producer.stopping || Promise.resolve();
    producer.retired = true;
    producer.abort.abort();
    if (this.producers.get(producer.key) === producer) this.producers.delete(producer.key);
    for (const id of producer.resourceIds) this.resources.delete(id);
    producer.targets.clear();
    producer.resourceIds.clear();
    for (const assignment of producer.leases) {
      assignment.released = true;
      if (this.streams.get(assignment.identity) === assignment) this.streams.delete(assignment.identity);
    }
    producer.leases.clear();
    producer.stopping = fetch(new URL(`/video/:/transcode/universal/stop?session=${encodeURIComponent(producer.session)}`, this.url), {
      headers: this.headers(producer.client), signal: AbortSignal.timeout(3000),
    }).then(response => response.arrayBuffer()).catch(() => {});
    return producer.stopping;
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
    this.cancelStart(this.pendingStarts.get(identity));
    const pending = { abort: new AbortController(), cancelled: false, provisional: false };
    this.pendingStarts.set(identity, pending);
    let cancelReady;
    const active = () => {
      if (pending.cancelled || this.pendingStarts.get(identity) !== pending || pending.assignment?.released) throw Object.assign(new Error('The stream changed. Reconnect to watch.'), { status: 409 });
    };
    try {
      const item = await this.metadata(movie.id, { signal: AbortSignal.any([pending.abort.signal, AbortSignal.timeout(20000)]) });
      active();
      const subtitle = this.subtitleTracks(item).find(track => track.id === subtitleId);
      if (subtitleId && !subtitle) throw Object.assign(new Error('This subtitle track is unavailable. Choose another track.'), { status: 400 });
      const media = array(item.Media)[0];
      const part = array(media?.Part)[0];
      if (!part?.key) throw new Error('Plex could not find this media file.');
      const codecs = hevc ? 'h264,hevc' : 'h264';
      const bitrate = Number.isFinite(maxBitrate) ? Math.max(1500, Math.floor(maxBitrate)) : 50000;
      const reducedResolution = remote !== false && adaptive;
      const resolution = reducedResolution && bitrate <= 4000 ? '1280x720' : reducedResolution && bitrate <= 12000 ? '1920x1080' : '3840x2160';
      const params = new URLSearchParams({
        path: `/library/metadata/${movie.id}`, mediaIndex: '0', partIndex: '0',
        protocol: 'hls', directPlay: '0', directStream: '1', directStreamAudio: '1',
        hasMDE: '1', location: remote === false ? 'lan' : 'wan', fastSeek: '1',
        ...(remote === false ? {} : { videoBitrate: String(bitrate), maxVideoBitrate: String(bitrate) }),
        videoResolution: resolution, videoQuality: '100', audioBoost: '100',
        subtitles: subtitle ? subtitle.burn ? 'burn' : 'segmented' : 'none',
        ...(subtitle ? { subtitleStreamID: subtitle.id, advancedSubtitles: subtitle.burn ? 'burn' : 'text' } : {}),
        copyts: '1', secondsPerSegment: '2',
        'X-Plex-Client-Profile-Name': 'generic',
        'X-Plex-Client-Profile-Extra': `add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mp4&videoCodec=${codecs}&audioCodec=aac&replace=true)+add-direct-play-profile(type=videoProfile&container=mp4,mkv&videoCodec=${codecs}&audioCodec=aac&subtitleCodec=webvtt)+add-transcode-target(type=subtitleProfile&context=all&protocol=hls&container=webvtt&subtitleCodec=webvtt)${hevc ? '+add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.bitDepth&value=10&replace=true)+add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.level&value=186&replace=true)' : ''}`,
      });
      const key = JSON.stringify([String(movie.id), movie.version, part.key, params.toString()]);
      let producer = this.producers.get(key);
      if (!producer) {
        const id = randomUUID();
        const session = `playparty-${randomUUID()}`;
        producer = { id, key, session, client: `playparty-output-${id}`, version: movie.version,
          resourceIds: new Set(), targets: new Map(), leases: new Set(), abort: new AbortController(), retired: false };
        this.producers.set(key, producer);
        params.set('offset', String(Math.max(0, position)));
        params.set('session', session);
        params.set('X-Plex-Session-Identifier', session);
        params.set('transcodeSessionId', session);
        const output = producer;
        producer.ready = (async () => {
          const decision = await this.json(`/video/:/transcode/universal/decision?${params}`, output.client, { signal: AbortSignal.any([output.abort.signal, AbortSignal.timeout(20000)]) });
          if (output.retired) throw Object.assign(new Error('The stream changed. Reconnect to watch.'), { status: 409 });
          const chosen = array(decision.Metadata)[0]?.Media?.[0];
          const tracks = array(chosen?.Part?.[0]?.Stream);
          const video = tracks.find(track => Number(track.streamType) === 1);
          output.diagnostics = { videoDecision: video?.decision, inputCodec: media?.videoCodec, maxBitrate: remote === false ? 0 : bitrate };
          const start = new URL(`/video/:/transcode/universal/start.m3u8?${params}`, this.url);
          return {
            url: this.addResource(output, start.toString()),
            outputId: output.id,
            offset: 0,
            quality: video?.decision === 'copy' ? 'Original video' : 'Optimized video',
            kind: 'hls',
            subtitleMode: subtitle ? subtitle.burn ? 'burn' : 'segmented' : 'none',
          };
        })().catch(async error => { await this.invalidate(output); throw error; });
      }
      const previous = this.streams.get(identity);
      const assignment = previous?.producer === producer && !previous.released ? previous : {
        identity, producer, id: producer.id, session: producer.session, client: producer.client, version: producer.version,
        resourceIds: producer.resourceIds, targets: producer.targets, get diagnostics() { return producer.diagnostics; },
      };
      pending.assignment = assignment;
      pending.provisional = assignment !== previous;
      producer.leases.add(assignment);
      const cancelled = new Promise((resolve, reject) => {
        cancelReady = () => reject(Object.assign(new Error('The stream changed. Reconnect to watch.'), { status: 409 }));
        pending.abort.signal.addEventListener('abort', cancelReady, { once: true });
      });
      const result = await Promise.race([producer.ready, cancelled]);
      active();
      this.streams.set(identity, assignment);
      pending.provisional = false;
      if (previous !== assignment) await this.stop(identity, previous);
      active();
      return result;
    } catch (error) {
      if (pending.provisional) await this.release(pending.assignment);
      if (pending.cancelled) throw Object.assign(new Error('The stream changed. Reconnect to watch.'), { status: 409 });
      throw error;
    } finally {
      if (cancelReady) pending.abort.signal.removeEventListener('abort', cancelReady);
      if (this.pendingStarts.get(identity) === pending) this.pendingStarts.delete(identity);
    }
  }
}
