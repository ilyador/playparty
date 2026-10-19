import type { LocalAudioTrack, RemoteTrack } from 'livekit-client';

export type MicrophoneDiagnostic = {
  event: 'microphone-status';
  microphonePublished: boolean;
  microphoneReadyState?: 'live' | 'ended';
  microphoneEnabled?: boolean;
  microphoneMuted?: boolean;
  microphoneUserMuted?: boolean;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};

export function microphoneStatus(track?: LocalAudioTrack): MicrophoneDiagnostic {
  if (!track) return { event: 'microphone-status', microphonePublished: false };
  const native = track.mediaStreamTrack;
  const sample: MicrophoneDiagnostic = {
    event: 'microphone-status', microphonePublished: true,
    microphoneReadyState: native.readyState, microphoneEnabled: native.enabled,
    microphoneMuted: native.muted, microphoneUserMuted: track.isMuted,
  };
  const settings = native.getSettings();
  for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const) {
    if (typeof settings[key] === 'boolean') sample[key] = settings[key];
  }
  return sample;
}

export function microphoneInterrupted(track?: LocalAudioTrack) {
  return Boolean(track && !track.isMuted && (track.mediaStreamTrack.readyState === 'ended' || track.mediaStreamTrack.muted));
}

export function observeMicrophone(track: LocalAudioTrack, onChange: (sample: MicrophoneDiagnostic) => void) {
  let native: MediaStreamTrack | undefined;
  const nativeEvents = ['mute', 'unmute', 'configurationchange'];
  function unbind() { for (const event of nativeEvents) native?.removeEventListener(event, update); }
  function update() {
    if (native !== track.mediaStreamTrack) {
      unbind();
      native = track.mediaStreamTrack;
      for (const event of nativeEvents) native.addEventListener(event, update);
    }
    onChange(microphoneStatus(track));
  }
  for (const event of ['muted', 'unmuted', 'restarted', 'ended'] as const) track.on(event, update);
  update();
  return () => {
    unbind();
    for (const event of ['muted', 'unmuted', 'restarted', 'ended'] as const) track.off(event, update);
  };
}

export type CallAudioDiagnostic = {
  event: 'call-audio-output';
  callAudioTracks: number;
  callAudioElements: number;
  callAudioPlaying: number;
  callAudioDuplicates: number;
  callAudioUnexpected: number;
  callAudioBoosted?: boolean;
};

function volumeLocked(element: HTMLMediaElement) {
  try { return element.matches(':volume-locked'); } catch { return false; }
}

// iPhone Safari ignores media volume, so the movie cannot be lowered while
// people talk. Raise their voices instead. The mix still plays as MediaStream
// audio through an element, which Safari echo-cancels like the voices
// themselves; Web Audio's own speaker output would not be.
function voiceBoost(container: HTMLElement, onChange: () => void) {
  const context = new AudioContext({ latencyHint: 'interactive' });
  const gain = context.createGain(), limiter = context.createDynamicsCompressor();
  const mix = context.createMediaStreamDestination();
  // With the limiter's makeup gain, about +11 dB: slightly more than
  // desktop's balance of a 30% movie under speech.
  gain.gain.value = 3;
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.002; limiter.release.value = 0.2;
  gain.connect(limiter).connect(mix);
  const output = document.createElement('audio');
  output.autoplay = true; output.className = 'call-audio'; output.srcObject = mix.stream;
  container.appendChild(output);
  const voices = new Map<HTMLMediaElement, MediaStreamAudioSourceNode>();
  const gestures = ['click', 'touchend'], outputEvents = ['playing', 'pause'], directEvents = ['playing', 'volumechange'];
  let active = false;
  function update() {
    // Safari starts audio without a tap while the microphone captures.
    if (context.state !== 'running' && context.state !== 'closed') context.resume().catch(() => {});
    if (output.paused) output.play().catch(() => {});
    // Direct playback stays audible until the boosted mix is. Room.startAudio()
    // unmutes direct elements, so a boosted voice is muted again here.
    const next = context.state === 'running' && !output.paused;
    for (const element of voices.keys()) if (element.muted !== next) element.muted = next;
    if (next !== active) { active = next; onChange(); }
  }
  function remove(element: HTMLMediaElement) {
    voices.get(element)?.disconnect(); voices.delete(element);
    for (const event of directEvents) element.removeEventListener(event, update);
  }
  context.addEventListener('statechange', update);
  for (const event of outputEvents) output.addEventListener(event, update);
  for (const event of gestures) container.addEventListener(event, update);
  return {
    get active() { return active; },
    add(element: HTMLMediaElement, track: MediaStreamTrack) {
      const voice = context.createMediaStreamSource(new MediaStream([track]));
      voice.connect(gain); voices.set(element, voice);
      for (const event of directEvents) element.addEventListener(event, update);
      update();
    },
    remove,
    dispose() {
      for (const element of [...voices.keys()]) remove(element);
      context.removeEventListener('statechange', update);
      for (const event of outputEvents) output.removeEventListener(event, update);
      for (const event of gestures) container.removeEventListener(event, update);
      output.remove(); context.close().catch(() => {});
    },
  };
}

export function remoteCallAudio(container: HTMLElement, onDiagnostic?: (sample: CallAudioDiagnostic) => void) {
  type Record = { track: RemoteTrack; element: HTMLAudioElement; publisher?: string; stopObserving: () => void };
  const elements = new Map<string, Record>();
  // Created for the first voice on a volume-locked browser; null if Safari refused it.
  let boost: ReturnType<typeof voiceBoost> | null | undefined;
  let previousDiagnostic = '';
  function report() {
    if (!onDiagnostic) return;
    const outputs = new Set<HTMLMediaElement>();
    const sources = new Map<string, Set<HTMLMediaElement>>();
    let unexpected = 0;
    for (const record of elements.values()) {
      const attached = record.track.attachedElements || [record.element];
      // Publisher and publication details stay in memory. Logs only receive
      // counts, including outputs attached elsewhere by another component.
      const key = record.publisher ? `${record.publisher}\0${record.track.source}` : record.track.sid;
      const source = sources.get(key!) || new Set<HTMLMediaElement>();
      for (const element of attached) { outputs.add(element); source.add(element); }
      sources.set(key!, source);
      if (record.track.source && record.track.source !== 'microphone') unexpected++;
    }
    const sample: CallAudioDiagnostic = {
      event: 'call-audio-output', callAudioTracks: elements.size, callAudioElements: outputs.size,
      callAudioPlaying: [...outputs].filter(element => !element.paused && !element.muted).length,
      callAudioDuplicates: [...sources.values()].reduce((count, source) => count + Math.max(0, source.size - 1), 0),
      callAudioUnexpected: unexpected,
    };
    if (boost) sample.callAudioBoosted = boost.active;
    const key = JSON.stringify(sample);
    if (key !== previousDiagnostic) { previousDiagnostic = key; onDiagnostic(sample); }
  }
  function remove(record: Record) {
    record.stopObserving(); boost?.remove(record.element);
    record.track.detach(record.element); record.element.remove();
  }
  return {
    attach(track: RemoteTrack, publisher?: string) {
      if (track.kind !== 'audio' || !track.sid) return;
      const previous = elements.get(track.sid);
      if (previous?.track === track) return previous.element;
      if (previous) remove(previous);
      const element = track.attach() as HTMLAudioElement;
      element.autoplay = true; element.className = 'call-audio';
      container.appendChild(element);
      const events = ['playing', 'pause', 'emptied', 'ended', 'volumechange'];
      for (const event of events) element.addEventListener(event, report);
      track.on('elementAttached', report); track.on('elementDetached', report);
      elements.set(track.sid, { track, element, publisher, stopObserving() {
        for (const event of events) element.removeEventListener(event, report);
        track.off('elementAttached', report); track.off('elementDetached', report);
      } });
      // A refused boost leaves the voice on direct playback.
      if (boost === undefined && volumeLocked(element)) {
        try { boost = voiceBoost(container, report); } catch { boost = null; }
      }
      try { boost?.add(element, track.mediaStreamTrack); } catch {}
      report();
      return element;
    },
    detach(track: RemoteTrack) {
      if (!track.sid) return;
      const record = elements.get(track.sid);
      // A late unsubscribe for the previous object must not remove its newer
      // replacement, which can have the same publication SID after reconnect.
      if (record?.track !== track) return;
      remove(record); elements.delete(track.sid); report();
    },
    dispose() { for (const record of elements.values()) remove(record); elements.clear(); boost?.dispose(); boost = undefined; report(); },
  };
}
