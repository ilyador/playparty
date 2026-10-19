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
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let previousDiagnostic = '';
  // iPhone Safari keeps movie volume on the hardware buttons, yet a write
  // reads back until Safari reverts it. Only WebKit knows ':volume-locked'.
  let lockedVolume = false;
  try { lockedVolume = video.matches(':volume-locked'); } catch {}
  let writableVolume = false;
  if (!lockedVolume) try {
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
    video.muted = muted;
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
      clearTimeout(restoreTimer);
      // Fixed movie volume is left alone; call audio raises the voices instead.
      if (writableVolume && speaking && !ducked) { ducked = true; apply(); }
      else if (writableVolume && !speaking && ducked) restoreTimer = setTimeout(() => { ducked = false; apply(); }, 800);
      report();
    },
    dispose() {
      disposed = true; speech = false; ducked = false;
      clearTimeout(restoreTimer); cancelAnimationFrame(frame);
      video.muted = muted;
      if (writableVolume) video.volume = originalVolume;
      report();
    },
  };
}
