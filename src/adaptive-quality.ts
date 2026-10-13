export type QualityReason = 'bandwidth' | 'stall' | 'recovery';
type QualityConfiguration = { remote: boolean; maxBitrate: number; currentBitrate?: number };
type FragmentSample = { bytes: number; downloadMs: number; duration: number; bufferAhead: number };
type PlaybackSample = { playing: boolean; seeking: boolean; bufferAhead: number; stalled: boolean };

const ladder = [1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000, 20000, 30000, 40000, 50000, 70000, 100000, 150000, 200000];
const validBitrate = (value: number) => Number.isFinite(value) ? Math.max(1500, Math.floor(value)) : 50000;

// Plex normally supplies a single rendition. This controller suggests a new
// per-viewer stream cap; changing Hls.autoLevel cannot adapt that rendition.
// Keep it across quality changes and configure it after the server accepts one.
export function createAdaptiveQuality({ remote, maxBitrate, currentBitrate, onChange, now = () => performance.now() }: QualityConfiguration & {
  onChange: (maxBitrate: number, reason: QualityReason) => void;
  now?: () => number;
}) {
  let ceiling = validBitrate(maxBitrate);
  let current = Math.min(ceiling, validBitrate(currentBitrate ?? ceiling));
  let startedAt = now();
  let changedAt = -Infinity;
  let pending = false;
  let fast = 0;
  let slow = 0;
  let lastFragmentAt = -Infinity;
  let pressure = 0;
  let stalledSince: number | undefined;
  let healthySince: number | undefined;

  const levels = () => [...new Set([...ladder.filter(value => value <= ceiling), ceiling])].sort((a, b) => a - b);
  const bandwidth = () => Math.min(fast, slow);
  function change(next: number, reason: QualityReason) {
    if (pending || next === current) return;
    pending = true;
    changedAt = now();
    healthySince = undefined;
    stalledSince = undefined;
    pressure = 0;
    onChange(next, reason);
  }
  function reduce(reason: 'bandwidth' | 'stall') {
    if (current <= 1500 || now() - changedAt < 20000) return;
    // A stalled transcoder can be the bottleneck as well as the connection.
    // With no useful transfer sample, 1080p at most is a practical first retry.
    const throughputLimit = bandwidth() > 0 && now() - lastFragmentAt < 15000 ? bandwidth() * 0.7 : 8000;
    const target = Math.max(1500, Math.min(current * 0.6, throughputLimit, reason === 'stall' ? 8000 : Infinity));
    const lower = levels().filter(value => value < current && value <= target).at(-1) ?? 1500;
    change(lower, reason);
  }

  return {
    configure(configuration: QualityConfiguration) {
      remote = configuration.remote;
      ceiling = validBitrate(configuration.maxBitrate);
      const accepted = Math.min(ceiling, validBitrate(configuration.currentBitrate ?? ceiling));
      if (accepted !== current) startedAt = now();
      current = accepted;
      pending = false;
      pressure = 0;
      stalledSince = undefined;
      healthySince = undefined;
    },
    fragment({ bytes, downloadMs, duration, bufferAhead }: FragmentSample) {
      if (!remote || ![bytes, downloadMs, duration, bufferAhead].every(Number.isFinite) || bytes <= 0 || downloadMs <= 0 || duration <= 0) return;
      const kbps = bytes * 8 / downloadMs;
      // Both fast and slow time-weighted estimates must support an upgrade.
      const weight = Math.min(10, Math.max(0.25, downloadMs / 1000));
      const average = (previous: number, halfLife: number) => previous ? previous + (kbps - previous) * (1 - 2 ** (-weight / halfLife)) : kbps;
      fast = average(fast, 3);
      slow = average(slow, 9);
      lastFragmentAt = now();
      // Compare transfer time with this actual rendition, rather than the cap:
      // a low-bitrate original should retain original quality on a fast link.
      pressure = downloadMs / 1000 >= duration * 0.9 && bufferAhead < 6 ? pressure + 1 : Math.max(0, pressure - 1);
    },
    sample({ playing, seeking, bufferAhead, stalled }: PlaybackSample) {
      const timestamp = now();
      if (!remote || pending || !playing || seeking || !Number.isFinite(bufferAhead)) {
        stalledSince = undefined;
        healthySince = undefined;
        return;
      }
      if (timestamp - startedAt < 6000) return;
      if (stalled && bufferAhead < 1) {
        stalledSince ??= timestamp;
        healthySince = undefined;
        if (timestamp - stalledSince >= 5000) reduce('stall');
        return;
      }
      stalledSince = undefined;
      if (pressure >= 3 && bufferAhead < 6 && timestamp - lastFragmentAt < 15000) {
        healthySince = undefined;
        reduce('bandwidth');
        return;
      }
      const next = levels().find(value => value > current);
      if (!next || stalled || bufferAhead < 10 || pressure > 0 || timestamp - lastFragmentAt > 15000 || bandwidth() < next * 1.6) {
        healthySince = undefined;
        return;
      }
      healthySince ??= timestamp;
      if (timestamp - healthySince >= 60000 && timestamp - changedAt >= 60000) change(next, 'recovery');
    },
  };
}
