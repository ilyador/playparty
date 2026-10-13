export function movieAudio(video: HTMLVideoElement) {
  const originalVolume = video.volume;
  let muted = video.muted;
  let ducked = false;
  let frame = 0;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let writableVolume = false;
  try {
    video.volume = originalVolume === 0.5 ? 0.4 : 0.5;
    writableVolume = Math.abs(video.volume - (originalVolume === 0.5 ? 0.4 : 0.5)) < 0.001;
    video.volume = originalVolume;
  } catch {}

  function apply() {
    cancelAnimationFrame(frame);
    video.muted = muted || (!writableVolume && ducked);
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
  return {
    setMuted(value: boolean) { muted = value; apply(); },
    setSpeech(speaking: boolean) {
      clearTimeout(restoreTimer);
      if (speaking) { if (!ducked) { ducked = true; apply(); } }
      else if (ducked) restoreTimer = setTimeout(() => { ducked = false; apply(); }, 800);
    },
    dispose() {
      clearTimeout(restoreTimer); cancelAnimationFrame(frame);
      video.muted = muted;
      if (writableVolume) video.volume = originalVolume;
    },
  };
}
