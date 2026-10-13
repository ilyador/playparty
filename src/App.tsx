import { useEffect, useRef, useState } from 'react';
import { AudioPresets, Room, RoomEvent, Track, VideoPresets, type LocalAudioTrack, type Participant } from 'livekit-client';
import { ArrowRight, FilmSlate, Microphone, MicrophoneSlash, PhoneDisconnect, SpinnerGap, VideoCamera, VideoCameraSlash } from '@phosphor-icons/react';
import { Face } from './Call';
import Library from './Library';
import Player from './Player';
import { callCapture, captureErrorName } from './call-capture';
import { createMovieElement } from './movie-element';
import { microphoneInterrupted, microphoneStatus, observeMicrophone, remoteCallAudio, toggleMicrophone, type MicrophoneDiagnostic } from './call-audio';
import { api, contentTitle, post, type Joined, type PartyState } from './types';

export default function App() {
  const [name, setName] = useState(() => localStorage.getItem('playparty-name') || '');
  const [host, setHost] = useState(false);
  const [loginUrl, setLoginUrl] = useState('/login');
  const [loginLabel, setLoginLabel] = useState('Sign in to host');
  const [plexLogin, setPlexLogin] = useState(false);
  const [recognizedOwner, setRecognizedOwner] = useState(false);
  const hostTouched = useRef(false);
  const loginInProgress = useRef(new URLSearchParams(location.search).has('plex-login'));
  const [joined, setJoined] = useState<Joined | null>(null);
  const [state, setState] = useState<PartyState | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [picker, setPicker] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [mic, setMic] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [camera, setCamera] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [connection, setConnection] = useState('Connecting');
  const [clockOffset, setClockOffset] = useState(0);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const call = useRef<Room | null>(null);
  const captureSession = useRef<ReturnType<typeof callCapture> | null>(null);
  const togglingDevice = useRef(false);
  const socket = useRef<WebSocket | null>(null);
  const leaveRef = useRef(false);
  const movieElement = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!new URLSearchParams(location.search).has('plex-login')) return;
    history.replaceState(null, '', location.pathname);
    hostTouched.current = true; setHost(true); setJoining(true);
    post('auth/complete', {}).then(() => {
      setRecognizedOwner(true); setNotice('Signed in. You can join as the host.');
    }).catch(error => setError(error.message)).finally(() => {
      loginInProgress.current = false; setJoining(false); window.dispatchEvent(new Event('focus'));
    });
  }, []);

  useEffect(() => {
    if (joined) return;
    const abort = new AbortController();
    const refresh = () => {
      if (loginInProgress.current) return;
      return api<{ state: PartyState; owner: boolean; loginUrl: string; loginLabel: string; plexLogin: boolean }>('session', { signal: abort.signal }).then(data => {
      setState(data.state); setLoginUrl(data.loginUrl); setLoginLabel(data.loginLabel); setPlexLogin(data.plexLogin); setRecognizedOwner(data.owner);
      if (!hostTouched.current) setHost(data.owner);
      }).catch(() => { if (!abort.signal.aborted) setError('Playparty is unavailable. Try again in a moment.'); });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => { abort.abort(); clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [Boolean(joined)]);

  useEffect(() => {
    if (!joined) return;
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const pendingDiagnostics = new Map<string, object>();
    leaveRef.current = false;
    setAudioBlocked(false);
    const connectEvents = () => {
      if (disposed) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
      socket.current = ws;
      ws.onopen = () => {
        if (disposed || leaveRef.current || socket.current !== ws) { ws.close(); return; }
        setConnectionVersion(version => version + 1);
        ws.send(JSON.stringify({ type: 'ping', sent: Date.now() }));
        for (const sample of pendingDiagnostics.values()) ws.send(JSON.stringify({ type: 'telemetry', ...sample }));
        pendingDiagnostics.clear();
        clearInterval(pingTimer);
        pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', sent: Date.now() })); }, 10000);
      };
      ws.onmessage = event => {
        if (disposed || leaveRef.current || socket.current !== ws) return;
        const message = JSON.parse(event.data);
        if (message.type === 'state') setState(message);
        if (message.type === 'pong') setClockOffset(message.serverTime - (Date.now() + message.sent) / 2);
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (!disposed && !leaveRef.current) reconnect = setTimeout(connectEvents, 1500);
      };
    };
    connectEvents();
    const room = new Room({
      adaptiveStream: true, dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      videoCaptureDefaults: { resolution: VideoPresets.h1080 },
      publishDefaults: {
        videoCodec: 'h264', videoEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 },
        videoSimulcastLayers: [VideoPresets.h360, VideoPresets.h180],
        audioPreset: AudioPresets.speech, simulcast: true, stopMicTrackOnMute: false,
      },
    });
    const diagnose = (sample: object) => {
      if (disposed || leaveRef.current) return;
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'telemetry', ...sample }));
      else pendingDiagnostics.set(String((sample as { event: string }).event), sample);
    };
    const capture = callCapture(room.localParticipant, diagnose);
    const remoteAudio = remoteCallAudio(document.body, diagnose);
    let monitoredMicrophone: LocalAudioTrack | undefined;
    let microphoneReported = false;
    let stopMonitoring = () => {};
    const microphoneStopped = 'Your microphone stopped. Tap the mic button to reconnect it.';
    const updateMicrophone = (sample: MicrophoneDiagnostic) => {
      if (disposed || leaveRef.current) return;
      microphoneReported = true;
      const working = Boolean(sample.microphonePublished && sample.microphoneReadyState === 'live' && sample.microphoneEnabled && !sample.microphoneMuted && !sample.microphoneUserMuted);
      setMic(working); diagnose(sample);
      if (microphoneInterrupted(monitoredMicrophone)) setNotice(microphoneStopped);
      else setNotice(previous => previous === microphoneStopped ? '' : previous);
    };
    captureSession.current = capture;
    call.current = room;
    const refresh = () => {
      if (disposed) return;
      setParticipants([room.localParticipant, ...room.remoteParticipants.values()]);
      const microphone = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
      if (microphone !== monitoredMicrophone || !microphoneReported) {
        stopMonitoring(); monitoredMicrophone = microphone;
        stopMonitoring = microphone ? observeMicrophone(microphone, updateMicrophone) : () => {};
        if (!microphone) updateMicrophone(microphoneStatus());
      }
      setCamera(room.localParticipant.isCameraEnabled);
      setSpeaking(room.activeSpeakers.some(participant => participant.isMicrophoneEnabled));
    };
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => { if (!disposed) remoteAudio.attach(track, participant.identity); refresh(); });
    room.on(RoomEvent.ActiveSpeakersChanged, refresh);
    room.on(RoomEvent.TrackUnsubscribed, track => {
      remoteAudio.detach(track);
      refresh();
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, playable => {
      if (disposed || leaveRef.current) return;
      setAudioBlocked(!playable);
      diagnose({ event: 'call-audio-status', canPlaybackAudio: playable });
    });
    room.on(RoomEvent.MediaDevicesError, error => {
      if (disposed || leaveRef.current) return;
      diagnose({ event: 'capture-error', audio: false, video: false, captureError: captureErrorName(error) });
      setNotice(room.localParticipant.lastMicrophoneError ? 'Your microphone could not start. Tap the mic button to try again.' : 'Your camera could not start. Tap the camera button to try again.');
    });
    for (const event of [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted]) room.on(event, refresh);
    room.on(RoomEvent.Reconnecting, () => setConnection('Reconnecting'));
    room.on(RoomEvent.Reconnected, () => setConnection('Connected'));
    room.on(RoomEvent.Disconnected, () => { if (!disposed) setConnection('Disconnected'); });
    room.connect(joined.livekitUrl, joined.token).then(async () => {
      if (disposed || leaveRef.current) return;
      setConnection('Connected'); refresh();
      await capture.start().catch(() => {
        if (!disposed && !leaveRef.current) setNotice(room.localParticipant.lastMicrophoneError ? 'Your microphone could not start. Tap the mic button to try again.' : 'Use the camera and mic buttons to enable your devices.');
      });
      if (!disposed && !leaveRef.current) { await room.startAudio().catch(() => {}); refresh(); }
    }).catch(() => { if (!disposed) { setConnection('Disconnected'); setNotice('The call could not connect. Check your connection and rejoin.'); } });
    return () => {
      disposed = true; clearTimeout(reconnect); clearInterval(pingTimer); socket.current?.close();
      capture.dispose();
      stopMonitoring();
      if (captureSession.current === capture) captureSession.current = null;
      room.disconnect();
      remoteAudio.dispose(); call.current = null;
    };
  }, [joined?.identity]);

  async function join(event: React.FormEvent) {
    event.preventDefault(); if (!name.trim()) return;
    if (host && plexLogin && !recognizedOwner) {
      localStorage.setItem('playparty-name', name.trim());
      location.assign(loginUrl); return;
    }
    // Keep the actual player element created and authorized by this Join tap.
    // Safari grants playback to an element, rather than to the React page.
    movieElement.current = createMovieElement(movieElement.current || undefined);
    setJoining(true); setError('');
    try {
      const data = await post<Joined>('join', { name: name.trim(), host });
      localStorage.setItem('playparty-name', data.name);
      setState(data.state); setJoined(data);
    } catch (error) { setError((error as Error).message); }
    finally { setJoining(false); }
  }
  async function leave() {
    leaveRef.current = true;
    captureSession.current?.dispose();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    setFullscreen(false);
    await post('leave', {}).catch(() => {});
    call.current?.disconnect(); socket.current?.close();
    setJoined(null); setParticipants([]); setMic(false); setCamera(false); setSpeaking(false); setNotice(''); setAudioBlocked(false); setPicker(false);
  }
  async function stopMovie() {
    const next = await post<PartyState>('stop', {});
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    setFullscreen(false);
    setState(next); setPicker(true);
  }
  async function toggleDevice(kind: 'mic' | 'camera') {
    const participant = call.current?.localParticipant;
    if (!participant || togglingDevice.current || leaveRef.current) return;
    togglingDevice.current = true;
    try {
      if (kind === 'mic') {
        await toggleMicrophone(participant.getTrackPublication(Track.Source.Microphone)?.audioTrack, participant.isMicrophoneEnabled, enabled => participant.setMicrophoneEnabled(enabled));
        const sample = microphoneStatus(participant.getTrackPublication(Track.Source.Microphone)?.audioTrack);
        setMic(Boolean(sample.microphonePublished && sample.microphoneReadyState === 'live' && sample.microphoneEnabled && !sample.microphoneMuted && !sample.microphoneUserMuted));
        if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'telemetry', ...sample }));
      }
      else { await participant.setCameraEnabled(!participant.isCameraEnabled); setCamera(participant.isCameraEnabled); }
      setNotice(''); setParticipants(previous => [...previous]);
    } catch { if (!leaveRef.current) setNotice(`Your ${kind === 'mic' ? 'microphone' : 'camera'} could not start. Tap its button to try again.`); }
    finally { togglingDevice.current = false; }
  }
  const remote = participants.filter(participant => participant.identity !== joined?.identity);
  const local = participants.find(participant => participant.identity === joined?.identity);
  const ordered = [...remote, ...(local ? [local] : [])];
  const watching = Boolean(joined && state?.movie);
  return <main className={`app${watching ? ' watching' : ''}${fullscreen ? ' is-fullscreen' : ''}`} style={{ '--people-count': Math.max(1, ordered.length) } as React.CSSProperties}>
    <header className="app-header"><a className="wordmark" href="/" aria-label="Playparty home">playparty<span className="wordmark-dot">.</span></a>
      {joined && <div className="party-status"><span className={`status-dot${connection !== 'Connected' ? ' reconnecting' : ''}`} />{connection === 'Connected' ? `${state?.participants.length || 1} ${state?.participants.length === 1 ? 'person' : 'people'} here` : connection}</div>}
    </header>
    {!joined ? <section className="join-screen">
      <div className="join-layout">
        <form className="join-form" onSubmit={join}>
          <h1>Join the party.</h1>
          <label className="name-label" htmlFor="name">Your name</label>
          <input id="name" className="name-input" autoComplete="given-name" autoFocus placeholder="What should we call you?" maxLength={40} value={name} onChange={event => setName(event.target.value)} required />
          <label className="host-choice" htmlFor="host"><span>I am the host</span><span className="host-switch"><input id="host" type="checkbox" role="switch" checked={host} disabled={joining} onChange={event => { hostTouched.current = true; setHost(event.target.checked); setError(''); }} /><span className="host-switch-track" aria-hidden="true" /></span></label>
          <button className="join-button" disabled={joining || !name.trim()}>{joining ? <><SpinnerGap className="spinner" size={20} />Joining…</> : <>Join<ArrowRight size={21} /></>}</button>
          {error && <p className="inline-error" role="alert">{error}</p>}
          {host && error && <a className="host-login-link" href={loginUrl} target={plexLogin ? undefined : '_blank'} rel="noreferrer">{loginLabel}</a>}
          <p className="join-caption">{state?.hostPresent ? 'Your people are already here.' : 'Come on in. Make yourself comfortable.'}</p>
        </form>
        {state?.movie && <div className="joining-movie"><img src={`/api/image/${state.movie.id}?kind=art`} alt="" /><div>{state.movie.seriesTitle ? <><strong className="series-name">{state.movie.seriesTitle}</strong><span className="episode-name">{state.movie.title}</span></> : <><span>Watching together</span><strong>{state.movie.title}</strong></>}<span className="episode-details">{state.movie.episodeDetails || state.movie.year}</span></div></div>}
      </div>
    </section> : <>
      <section className={`stage${watching ? ' has-movie' : ''}`}>
        {watching && state && movieElement.current ? <div className="movie-stage"><Player key={state.movie?.id} mediaElement={movieElement.current} state={state} owner={joined.owner} speaking={speaking} clockOffset={clockOffset} connectionVersion={connectionVersion} fullscreen={fullscreen} onFullscreen={setFullscreen} onStop={stopMovie} onReady={version => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'ready', mediaVersion: version })); }} onBuffering={version => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'buffering', mediaVersion: version })); }} onTelemetry={sample => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'telemetry', ...sample })); }} /></div>
          : <div className={`call-stage participants-${Math.min(ordered.length, 5)}`}>
            {remote.length === 0 && <div className="waiting"><span className="waiting-icon"><VideoCamera size={32} weight="light" /></span><h1>Room for good company.</h1><p>{joined.owner ? 'Send the link. Your friends will join you here.' : state?.hostPresent ? 'You’re in. The host will pick something to watch.' : 'You’re in. Waiting for the host.'}</p>{joined.owner && <button className="secondary-button" onClick={() => setPicker(true)}><FilmSlate size={19} />Choose something to watch</button>}</div>}
            {ordered.map(participant => <Face key={participant.identity} participant={participant} local={participant.identity === joined.identity} large={remote.length > 0} />)}
          </div>}
        {watching && <aside className="people-strip" aria-label="People in the call" style={{ '--people-count': Math.max(1, ordered.length) } as React.CSSProperties}>{ordered.map(participant => <Face key={participant.identity} participant={participant} local={participant.identity === joined.identity} />)}</aside>}
      </section>
      <footer className="call-footer">
        <div className="footer-content">{watching && state?.movie ? <><strong>{contentTitle(state.movie)}</strong><span>{state.movie.episodeDetails || state.movie.year}{state.paused && !state.waiting ? ' · Paused' : ''}</span></> : <><strong>{joined.name}</strong><span>{joined.owner ? 'You’re hosting' : 'Just you and your people'}</span></>}</div>
        <div className="call-controls">
          <div className="call-device-controls">
          <button className={`call-button${!mic ? ' device-off' : ''}`} onClick={() => toggleDevice('mic')} aria-label={mic ? 'Mute microphone' : 'Turn on microphone'} aria-pressed={mic}>{mic ? <Microphone size={23} /> : <MicrophoneSlash size={23} />}</button>
          <button className={`call-button${!camera ? ' device-off' : ''}`} onClick={() => toggleDevice('camera')} aria-label={camera ? 'Turn off camera' : 'Turn on camera'} aria-pressed={camera}>{camera ? <VideoCamera size={23} /> : <VideoCameraSlash size={23} />}</button>
          </div>
          <span className="controls-divider" />
          <button className="call-button hangup" onClick={leave} aria-label="Leave the call"><PhoneDisconnect size={25} weight="fill" /></button>
        </div>
        <div className="footer-action">{joined.owner && <button className="choose-button" aria-label={watching ? 'Change movie' : 'Choose a movie'} onClick={() => setPicker(true)}><FilmSlate size={20} /><span>{watching ? 'Change movie' : 'Choose a movie'}</span></button>}</div>
      </footer>
      {audioBlocked ? <div className="notice" role="status"><span>Tap to hear the call.</span><button onClick={() => { call.current?.startAudio().catch(() => {}); }}>Enable call audio</button></div>
        : notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}>Dismiss</button></div>}
      {picker && joined.owner && <Library onClose={() => setPicker(false)} onSelected={() => setPicker(false)} />}
    </>}
  </main>;
}
