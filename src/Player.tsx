import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { ArrowsIn, ArrowsOut, Pause, Play, SpeakerHigh, SpeakerSlash, SpinnerGap, Stop, Subtitles } from '@phosphor-icons/react';
import { api, contentTitle, positionAt, post, type PartyState } from './types';
import { movieAudio } from './movie-audio';

type Playback = { url: string; offset: number; quality: string; resolution: string; mediaVersion: number; subtitleMode: 'none' | 'segmented' | 'burn' };
const time = (value: number) => {
  const seconds = Math.max(0, Math.floor(value || 0));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export default function Player({ state, owner, speaking, clockOffset, onReady, onBuffering, onTelemetry, onStop, fullscreen, onFullscreen }: { state: PartyState; owner: boolean; speaking: boolean; clockOffset: number; onReady: (version: number) => void; onBuffering: (version: number) => void; onTelemetry: (sample: Record<string, string | number | boolean>) => void; onStop: () => Promise<void>; fullscreen: boolean; onFullscreen: (active: boolean) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const offsetRef = useRef(0);
  const playback = useRef<Playback | null>(null);
  const onReadyRef = useRef(onReady);
  const clockRef = useRef(clockOffset);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [position, setPosition] = useState(0);
  const [muted, setMuted] = useState(false);
  const [quality, setQuality] = useState('');
  const [controls, setControls] = useState(true);
  const [subtitleId, setSubtitleId] = useState('');
  const [stopping, setStopping] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seeking = useRef(false);
  const gestureRequired = useRef(false);
  const pendingPlay = useRef<Promise<void> | null>(null);
  const audio = useRef<ReturnType<typeof movieAudio> | null>(null);
  const readyCheck = useRef<() => void>(() => {});
  const bufferingReported = useRef(false);
  const lastCorrection = useRef(0);
  const lastSample = useRef(0);
  const onBufferingRef = useRef(onBuffering);
  const onTelemetryRef = useRef(onTelemetry);
  stateRef.current = state;
  onReadyRef.current = onReady;
  clockRef.current = clockOffset;
  onBufferingRef.current = onBuffering;
  onTelemetryRef.current = onTelemetry;

  function ahead(element: HTMLVideoElement, target: number) {
    for (let i = 0; i < element.buffered.length; i++) {
      if (target >= element.buffered.start(i) - 0.1 && target < element.buffered.end(i)) return Math.max(0, element.buffered.end(i) - target);
    }
    return 0;
  }
  function report(event: string) {
    const element = video.current;
    if (!element) return;
    const current = stateRef.current;
    const target = Math.max(0, positionAt(current, Date.now() + clockRef.current) - offsetRef.current);
    onTelemetryRef.current({ event, mediaVersion: current.mediaVersion, position: element.currentTime + offsetRef.current, target: target + offsetRef.current,
      drift: element.currentTime - target, bufferAhead: ahead(element, element.currentTime), readyState: element.readyState, rate: element.playbackRate,
      paused: element.paused, waiting: current.waiting, seeking: element.seeking });
  }
  function holdForBuffer() {
    const current = stateRef.current;
    if (current.paused || bufferingReported.current || performance.now() - lastCorrection.current < 750) return;
    bufferingReported.current = true;
    report('waiting'); onBufferingRef.current(current.mediaVersion);
  }

  useEffect(() => {
    if (!video.current) return;
    const controller = movieAudio(video.current);
    audio.current = controller;
    return () => { controller.dispose(); if (audio.current === controller) audio.current = null; };
  }, []);
  useEffect(() => { audio.current?.setMuted(muted); }, [muted]);
  useEffect(() => { audio.current?.setSpeech(speaking); }, [speaking]);

  function setGestureRequired(required: boolean) {
    gestureRequired.current = required; setNeedsGesture(required);
  }
  function playVideo(fromGesture = false) {
    const element = video.current;
    if (!element || (!fromGesture && (gestureRequired.current || pendingPlay.current))) return;
    const version = stateRef.current.mediaVersion;
    if (fromGesture) setGestureRequired(false);
    const attempt = element.play();
    pendingPlay.current = attempt;
    attempt.catch(error => {
      if (error.name === 'NotAllowedError' && element.paused && !stateRef.current.paused && stateRef.current.mediaVersion === version) { setGestureRequired(true); report('needs-gesture'); }
    }).finally(() => { if (pendingPlay.current === attempt) pendingPlay.current = null; });
  }

  function placeCaptions() {
    const element = video.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const app = container.current?.closest('.app');
    const faces = (document.fullscreenElement || app?.classList.contains('is-fullscreen')) && app?.querySelector('.people-strip')?.getBoundingClientRect();
    const overlapsMovie = faces && faces.left < bounds.right && faces.right > bounds.left;
    const line = faces && overlapsMovie && bounds.height ? Math.max(20, Math.min(80, (faces.top - bounds.top - 64) / bounds.height * 100)) : 80;
    for (const track of element.textTracks) for (const cue of track.cues || []) {
      if (cue instanceof VTTCue) { cue.snapToLines = false; cue.line = line; }
    }
  }

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const tracks = new Set<TextTrack>();
    const addTrack = (event: TrackEvent) => {
      if (!event.track) return;
      tracks.add(event.track);
      event.track.addEventListener('cuechange', placeCaptions);
    };
    element.textTracks.addEventListener('addtrack', addTrack);
    document.addEventListener('fullscreenchange', placeCaptions);
    window.addEventListener('resize', placeCaptions);
    return () => {
      element.textTracks.removeEventListener('addtrack', addTrack);
      document.removeEventListener('fullscreenchange', placeCaptions);
      window.removeEventListener('resize', placeCaptions);
      for (const track of tracks) track.removeEventListener('cuechange', placeCaptions);
    };
  }, []);

  useEffect(() => {
    const element = video.current;
    if (!element || !state.movie) return;
    const abort = new AbortController();
    let hls: Hls | undefined;
    let nativeSubtitles: (() => void) | undefined;
    let readySent = false;
    let wasWaiting = false;
    playback.current = null;
    bufferingReported.current = false;
    if (!stateRef.current.paused) {
      bufferingReported.current = true; report('waiting'); onBufferingRef.current(state.mediaVersion);
    }
    setError(''); setLoading(true); setGestureRequired(false);
    const playing = () => { setGestureRequired(false); bufferingReported.current = false; report('playing'); };
    const waiting = () => { setLoading(true); holdForBuffer(); };
    element.addEventListener('playing', playing);
    element.addEventListener('waiting', waiting);
    const markReady = () => {
      nativeSubtitles?.();
      if (element.readyState >= 3) setLoading(false);
      const current = stateRef.current;
      if (current.mediaVersion !== state.mediaVersion) return;
      if (!current.waiting) { wasWaiting = false; return; }
      if (!wasWaiting) { readySent = false; wasWaiting = true; }
      const target = Math.max(0, current.position - offsetRef.current);
      const needed = Math.min(4, Math.max(0.2, (current.movie?.duration || Infinity) - current.position - 0.1));
      if (!playback.current || element.readyState < 1) return;
      if (!element.seeking && Math.abs(element.currentTime - target) > 0.35) {
        if (performance.now() - lastCorrection.current >= 2000) { lastCorrection.current = performance.now(); element.currentTime = target; }
        return;
      }
      if (element.readyState < 2 || element.seeking || ahead(element, target) < needed) return;
      setLoading(false);
      if (!readySent) { readySent = true; report('ready'); onReadyRef.current(state.mediaVersion); }
    };
    readyCheck.current = markReady;
    element.addEventListener('canplay', markReady);
    const hevc = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"');
    api<Playback>('playback', { method: 'POST', body: JSON.stringify({ hevc, subtitleId }), signal: abort.signal }).then(async result => {
      if (abort.signal.aborted) return;
      const { default: Hls } = await import('hls.js');
      if (abort.signal.aborted) return;
      playback.current = result; offsetRef.current = result.offset;
      setQuality(result.quality);
      if (Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 16, maxMaxBufferLength: 30, backBufferLength: 8, enableWorker: true, manifestLoadingTimeOut: 30000, levelLoadingTimeOut: 30000, fragLoadingTimeOut: 30000 });
        // Plex marks the requested rendition DEFAULT=YES. Let Hls select it
        // after the active subtitle group exists, rather than during parsing.
        hls.subtitleDisplay = result.subtitleMode === 'segmented';
        hls.on(Hls.Events.BUFFER_APPENDED, markReady);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal || abort.signal.aborted) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError();
          else { report('fatal'); setError('The movie could not load. Try again.'); setLoading(false); }
        });
        hls.loadSource(result.url);
        hls.attachMedia(element);
      } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
        nativeSubtitles = () => {
          for (const track of element.textTracks) if (['subtitles', 'captions'].includes(track.kind)) track.mode = result.subtitleMode === 'segmented' ? 'showing' : 'disabled';
        };
        element.textTracks.addEventListener('addtrack', nativeSubtitles);
        element.src = result.url;
      } else { setError('This browser cannot play this stream. Try Safari, Chrome or Edge.'); setLoading(false); }
    }).catch(error => { if (!abort.signal.aborted) { setError(error.message); setLoading(false); } });
    return () => { abort.abort(); readyCheck.current = () => {}; element.pause(); hls?.destroy(); if (nativeSubtitles) element.textTracks.removeEventListener('addtrack', nativeSubtitles); element.removeEventListener('canplay', markReady); element.removeEventListener('playing', playing); element.removeEventListener('waiting', waiting); element.removeAttribute('src'); element.load(); };
  }, [state.movie?.id, state.mediaVersion, subtitleId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const element = video.current;
      const current = stateRef.current;
      if (!element) return;
      if (Date.now() - lastSample.current >= 10000) { lastSample.current = Date.now(); report('sample'); }
      readyCheck.current();
      if (!playback.current) return;
      const now = Date.now() + clockRef.current;
      const desired = Math.max(0, positionAt(current, now) - offsetRef.current);
      if (current.paused || now < current.updatedAt) {
        if (!element.paused) element.pause();
        if (!current.waiting && !element.seeking && ahead(element, desired) > 0.2 && Math.abs(element.currentTime - desired) > 0.35 && performance.now() - lastCorrection.current >= 2000) {
          lastCorrection.current = performance.now(); element.currentTime = desired;
        }
        if (!seeking.current) setPosition(element.currentTime + offsetRef.current);
        return;
      }
      if (element.readyState < 3) { holdForBuffer(); return; }
      if (Math.abs(element.currentTime - desired) > 1 && !element.seeking) {
        if (ahead(element, desired) < 0.5) { holdForBuffer(); return; }
        if (performance.now() - lastCorrection.current >= 2000) { lastCorrection.current = performance.now(); element.currentTime = desired; report('correction'); }
      }
      const difference = desired - element.currentTime;
      element.playbackRate = !current.paused && Math.abs(difference) > 0.12 ? difference > 0 ? 1.03 : 0.97 : 1;
      if (element.paused) playVideo();
      if (!seeking.current) setPosition(element.currentTime + offsetRef.current);
    }, 350);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const changed = () => onFullscreen(Boolean(document.fullscreenElement));
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.fullscreenElement && !document.querySelector('dialog[open]')) onFullscreen(false); };
    document.addEventListener('fullscreenchange', changed);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('fullscreenchange', changed); document.removeEventListener('keydown', escape); clearTimeout(hideTimer.current); };
  }, []);
  useEffect(() => { const frame = requestAnimationFrame(placeCaptions); return () => cancelAnimationFrame(frame); }, [fullscreen]);
  function showControls() {
    setControls(true); clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (!stateRef.current.paused) setControls(false); }, 2600);
  }
  useEffect(() => {
    showControls();
    if (state.paused) clearTimeout(hideTimer.current);
  }, [state.paused, state.movie?.id]);
  async function control(action: string, nextPosition?: number) {
    try { await post('control', { action, position: nextPosition }); }
    catch (error) { setError((error as Error).message); }
  }
  async function toggleFullscreen() {
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => onFullscreen(false)); return; }
    if (fullscreen) { onFullscreen(false); return; }
    try { await container.current?.closest('.app')?.requestFullscreen(); }
    catch { onFullscreen(true); }
  }
  async function stopMovie() {
    setStopping(true);
    try { await onStop(); }
    catch (error) { setError((error as Error).message); setStopping(false); }
  }
  const subtitles = state.movie?.subtitles || [];
  const duration = state.movie?.duration || 1;
  return <div className={`movie-player${controls || state.paused ? ' controls-visible' : ''}`} ref={container} onPointerMove={showControls} onPointerDown={showControls} onFocusCapture={showControls}>
    <video ref={video} playsInline controls={false} disablePictureInPicture disableRemotePlayback controlsList="nofullscreen noremoteplayback" muted={muted} className="movie-video" onWaiting={() => setLoading(true)} onPlaying={() => setLoading(false)} onEnded={() => { if (owner) control('pause'); }} />
    {(loading || state.waiting) && !error && <div className="player-loading"><SpinnerGap className="spinner" size={30} /><span>{state.waiting && !loading ? 'Getting everyone in sync…' : 'Getting the movie ready…'}</span></div>}
    {needsGesture && !state.paused && !error && <button className="watch-prompt" onClick={() => playVideo(true)}><Play size={22} weight="fill" />Tap to watch</button>}
    {error && <div className="player-error" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => { window.location.reload(); }}>Reconnect</button></div>}
    <div className="movie-topline"><div className="movie-title"><strong>{state.movie && contentTitle(state.movie)}</strong>{state.movie?.episodeDetails && <span>{state.movie.episodeDetails}</span>}</div><span className="quality-label">{quality}</span></div>
    <div className="movie-controls">
      <input className="seek" aria-label="Movie position" type="range" min="0" max={duration} step="1" value={Math.min(position, duration)} disabled={!owner} onPointerDown={() => { seeking.current = true; }} onKeyDown={() => { seeking.current = true; }} onChange={event => setPosition(Number(event.target.value))} onPointerUp={event => { seeking.current = false; if (owner) control('seek', Number(event.currentTarget.value)); }} onPointerCancel={() => { seeking.current = false; }} onBlur={() => { seeking.current = false; }} onKeyUp={event => { seeking.current = false; if (owner && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) control('seek', Number(event.currentTarget.value)); }} style={{ '--progress': `${Math.min(100, position / duration * 100)}%` } as React.CSSProperties} />
      <div className="movie-control-row"><div className="movie-control-group">
        {owner && <button className="icon-button" aria-label={state.paused ? 'Play movie' : 'Pause movie'} onClick={() => control(state.paused ? 'play' : 'pause')}>{state.paused ? <Play size={21} weight="fill" /> : <Pause size={21} weight="fill" />}</button>}
        {owner && <button className="icon-button" aria-label="Stop movie" title="Stop and choose another movie" disabled={stopping} onClick={stopMovie}>{stopping ? <SpinnerGap size={21} className="spinner" /> : <Stop size={19} weight="fill" />}</button>}
        <button className="icon-button" aria-label={muted ? 'Unmute movie' : 'Mute movie'} onClick={() => setMuted(!muted)}>{muted ? <SpeakerSlash size={21} /> : <SpeakerHigh size={21} />}</button>
        <span className="movie-time">{time(position)}<span> / {time(duration)}</span></span>
      </div><div className="movie-control-group">
        <label className={`subtitle-picker icon-button${subtitleId ? ' active' : ''}${!subtitles.length ? ' unavailable' : ''}`} title={subtitles.length ? 'Choose subtitles' : 'No subtitles in Plex'}>
          <Subtitles size={22} weight={subtitleId ? 'fill' : 'regular'} aria-hidden="true" />
          <select aria-label="Subtitles" value={subtitleId} disabled={!subtitles.length || stopping} onChange={event => setSubtitleId(event.target.value)}>
            <option value="">{subtitles.length ? 'Off' : 'No subtitles in Plex'}</option>
            {subtitles.map(track => <option key={track.id} value={track.id}>{track.label}</option>)}
          </select>
        </label>
        <button className="icon-button" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen movie'} onClick={toggleFullscreen}>{fullscreen ? <ArrowsIn size={21} /> : <ArrowsOut size={21} />}</button>
      </div></div>
    </div>
  </div>;
}
