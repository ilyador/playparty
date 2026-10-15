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
  const tracks = new Set<LocalTrack>();
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
      releasing.set(track, participant.unpublishTrack(track, true).then(() => {}, () => {}).finally(() => {
        track.stop(); tracks.delete(track); publishing.delete(track); releasing.delete(track);
      }));
    }
    return releasing.get(track)!;
  }

  function stop(owned: Iterable<LocalTrack> = tracks) {
    for (const track of owned) {
      track.stop();
      if (publishing.has(track)) void release(track);
      else tracks.delete(track);
    }
  }

  async function acquireAndPublish(audio: boolean, video: boolean) {
    let acquired: LocalTrack[] = [];
    let failed = false;
    diagnose('capture-request', audio, video);
    try {
      acquired = await participant.createTracks({ audio, video });
      for (const track of acquired) tracks.add(track);
      if (disposed) { stop(acquired); return; }
      diagnose('capture-ready', acquired.some(track => track.kind === 'audio'), acquired.some(track => track.kind === 'video'));
      await Promise.all(acquired.map(async track => {
        if (disposed) return;
        publishing.add(track);
        await participant.publishTrack(track);
        if (disposed || failed) await release(track);
      }));
    } catch (error) {
      failed = true;
      stop(acquired);
      diagnose('capture-error', false, false, captureErrorName(error));
      throw error;
    }
  }

  return {
    get active() { return !disposed; },
    async start() {
      if (!disposed) await acquireAndPublish(true, true);
    },
    async enable(kind: 'mic' | 'camera', previous?: LocalTrack) {
      if (disposed) return;
      if (previous) {
        previous.stop();
        await release(previous);
        if (disposed) return;
      }
      await acquireAndPublish(kind === 'mic', kind === 'camera');
    },
    dispose() { disposed = true; stop(); },
  };
}
