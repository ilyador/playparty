import type { LocalParticipant, LocalTrack } from 'livekit-client';

export type CaptureDiagnostic = {
  event: 'capture-request' | 'capture-ready' | 'capture-error';
  audio: boolean;
  video: boolean;
  microphonePermission?: PermissionState;
  cameraPermission?: PermissionState;
  captureError?: CaptureError;
};

export type CaptureError = 'NotAllowedError' | 'NotFoundError' | 'NotReadableError' | 'OverconstrainedError' | 'AbortError' | 'SecurityError' | 'InvalidStateError' | 'UnknownError';

export function captureErrorName(error: unknown): CaptureError {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  return ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError', 'SecurityError', 'InvalidStateError'].includes(name as string) ? name as CaptureError : 'UnknownError';
}

type CaptureParticipant = Pick<LocalParticipant, 'createTracks' | 'publishTrack' | 'unpublishTrack'>;

// Own tracks before publication: disconnecting a Room cannot release a capture
// request that is still awaiting the browser's permission dialog.
export function callCapture(participant: CaptureParticipant, onDiagnostic?: (sample: CaptureDiagnostic) => void) {
  let disposed = false;
  let tracks: LocalTrack[] = [];
  let starting: Promise<boolean> | undefined;
  const publishing = new Set<LocalTrack>();
  const releasing = new Map<LocalTrack, Promise<void>>();

  function diagnose(event: CaptureDiagnostic['event'], audio: boolean, video: boolean, captureError?: CaptureError) {
    if (!onDiagnostic) return;
    const sample: CaptureDiagnostic = { event, audio, video };
    if (captureError) sample.captureError = captureError;
    // Safari can leave a permission query pending. Capture events still need
    // to reach diagnostics while that optional metadata is unavailable.
    onDiagnostic({ ...sample });
    // Queries never request capture and never hold up capture or cleanup. Some
    // browsers do not support these permission names, so omit unknown states.
    const query = async (name: 'microphone' | 'camera') => {
      try {
        const state = (await navigator.permissions.query({ name: name as PermissionName })).state;
        if (state === 'granted' || state === 'prompt' || state === 'denied') sample[name === 'microphone' ? 'microphonePermission' : 'cameraPermission'] = state;
      } catch {}
    };
    void Promise.all([query('microphone'), query('camera')]).then(() => {
      if (sample.microphonePermission || sample.cameraPermission) onDiagnostic(sample);
    }).catch(() => {});
  }

  function release(track: LocalTrack) {
    if (!releasing.has(track)) {
      // LiveKit waits for an in-flight publish before unpublishing. Stop now so
      // the device is released immediately, then remove any late publication.
      releasing.set(track, participant.unpublishTrack(track, true).then(() => {}, () => {}).finally(() => track.stop()));
    }
    return releasing.get(track)!;
  }

  function stop() {
    for (const track of tracks) {
      track.stop();
      if (publishing.has(track)) void release(track);
    }
  }

  async function acquireAndPublish() {
    diagnose('capture-request', true, true);
    try {
      tracks = await participant.createTracks({ audio: true, video: true });
      if (disposed) { stop(); return false; }
      diagnose('capture-ready', tracks.some(track => track.kind === 'audio'), tracks.some(track => track.kind === 'video'));
      await Promise.all(tracks.map(async track => {
        if (disposed) return;
        publishing.add(track);
        await participant.publishTrack(track);
        if (disposed) await release(track);
      }));
      return !disposed;
    } catch (error) {
      disposed = true;
      stop();
      diagnose('capture-error', false, false, captureErrorName(error));
      throw error;
    }
  }

  return {
    start() {
      if (disposed) return Promise.resolve(false);
      return starting ??= acquireAndPublish();
    },
    dispose() { disposed = true; stop(); },
  };
}
