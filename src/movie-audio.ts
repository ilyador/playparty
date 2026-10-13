export type MovieAudioDiagnostic = {
  event: 'movie-audio';
  speech: boolean;
  ducked: boolean;
  volumeWritable: boolean;
  movieMuted: boolean;
};

export function movieAudio(video: HTMLVideoElement, onDiagnostic?: (sample: MovieAudioDiagnostic) => void) {
  const originalVolume = video.volume;
  let muted = video.muted;
  let speech = false;
  let ducked = false;
  let disposed = false;
  let frame = 0;
  let speechTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let previousDiagnostic = '';
  let writableVolume = false;
  try {
    video.volume = originalVolume === 0.5 ? 0.4 : 0.5;
    writableVolume = Math.abs(video.volume - (originalVolume === 0.5 ? 0.4 : 0.5)) < 0.001;
    video.volume = originalVolume;
  } catch {}

  function report() {
    const sample: MovieAudioDiagnostic = { event: 'movie-audio', speech, ducked, volumeWritable: writableVolume, movieMuted: video.muted };
    const key = JSON.stringify(sample);
    if (key === previousDiagnostic) return;
    previousDiagnostic = key;
    onDiagnostic?.(sample);
  }

  function apply() {
    cancelAnimationFrame(frame);
    video.muted = muted || (!writableVolume && ducked);
    report();
    if (!writableVolume) return;
    const from = video.volume;
    const to = originalVolume * (ducked ? 0.3 : 1);
    const duration = ducked ? 120 : 450;
    const started = performance.now();
    const fade = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      video.volume = from + (to - from) * eased;
      if (progress < 1) frame = requestAnimationFrame(fade);
    };
    frame = requestAnimationFrame(fade);
  }
  report();
  return {
    setMuted(value: boolean) { if (!disposed && muted !== value) { muted = value; apply(); } },
    setSpeech(speaking: boolean) {
      if (disposed || speech === speaking) return;
      speech = speaking;
      clearTimeout(speechTimer);
      clearTimeout(restoreTimer);
      if (speaking && !ducked) {
        // iOS volume can be read-only, which makes ducking an abrupt mute.
        // Require a sustained speech signal before interrupting the movie.
        if (!writableVolume) speechTimer = setTimeout(() => { ducked = true; apply(); }, 300);
        else { ducked = true; apply(); }
      } else if (!speaking && ducked) {
        restoreTimer = setTimeout(() => { ducked = false; apply(); }, writableVolume ? 800 : 1200);
      }
      report();
    },
    dispose() {
      disposed = true; speech = false; ducked = false;
      clearTimeout(speechTimer); clearTimeout(restoreTimer); cancelAnimationFrame(frame);
      video.muted = muted;
      if (writableVolume) video.volume = originalVolume;
      report();
    },
  };
}
