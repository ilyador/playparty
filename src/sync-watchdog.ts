// Verify hard corrections using playback after the seek, not the seek jump.
export function syncWatchdog() {
  let baseline: { at: number; position: number } | undefined;
  let corrected = false;
  let failures = 0;
  let lastReload = -Infinity;
  function reset() { baseline = undefined; corrected = false; failures = 0; }
  function recover(now: number) {
    if (now - lastReload < 30000) return false;
    lastReload = now; reset();
    return true;
  }
  return {
    reset,
    recover,
    corrected(now: number, position: number) { baseline = { at: now, position }; corrected = true; },
    sample(now: number, position: number, target: number, eligible: boolean, seeking: boolean) {
      if (!eligible || ![now, position, target].every(Number.isFinite)) { reset(); return false; }
      // A correction's own seek must finish before it can be evaluated.
      if (seeking) return false;
      if (!baseline) { baseline = { at: now, position }; return false; }
      if (now - baseline.at < 2000) return false;
      const healthy = position - baseline.position >= 0.2 && Math.abs(position - target) <= 1;
      if (corrected) failures = healthy ? 0 : failures + 1;
      else if (healthy) failures = 0;
      baseline = { at: now, position }; corrected = false;
      return failures >= 2 && recover(now);
    },
  };
}
