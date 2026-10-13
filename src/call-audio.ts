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
};

export function remoteCallAudio(container: HTMLElement, onDiagnostic?: (sample: CallAudioDiagnostic) => void) {
  type Record = { track: RemoteTrack; element: HTMLAudioElement; publisher?: string; stopObserving: () => void };
  const elements = new Map<string, Record>();
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
    const key = JSON.stringify(sample);
    if (key !== previousDiagnostic) { previousDiagnostic = key; onDiagnostic(sample); }
  }
  function remove(record: Record) {
    record.stopObserving();
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
    dispose() { for (const record of elements.values()) remove(record); elements.clear(); report(); },
  };
}
