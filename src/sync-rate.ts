// Small clock jitter should not continually reconfigure audio time stretching.
// Once correcting, keep a stable rate until the clocks are close again.
export function syncRate(previous: number, drift: number) {
  if (!Number.isFinite(drift)) return 1;
  if (drift > 0.35) return 1.03;
  if (drift < -0.35) return 0.97;
  if (previous > 1 && drift > 0.08) return 1.03;
  if (previous < 1 && drift < -0.08) return 0.97;
  return 1;
}
