export type QualityReason = 'bandwidth' | 'stall' | 'recovery';
type QualityConfiguration = { remote: boolean; maxBitrate: number; currentBitrate?: number; measuredTransfers?: boolean; originalBitrate?: number };
type FragmentSample = { bytes: number; downloadMs: number; duration: number; bufferAhead: number };
type PlaybackSample = { playing: boolean; seeking: boolean; bufferAhead: number; stalled: boolean; stallBitrate?: number; advancing?: boolean };

const ladder = [1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000, 20000, 30000, 40000, 50000, 70000, 100000, 150000, 200000];
const validBitrate = (value: number) => Number.isFinite(value) ? Math.max(1500, Math.floor(value)) : 50000;

// Plex normally supplies a single rendition. This controller suggests a new
// per-viewer stream cap; changing Hls.autoLevel cannot adapt that rendition.
// Keep it across quality changes and configure it after the server accepts one.
export function createAdaptiveQuality({ remote, maxBitrate, currentBitrate, measuredTransfers = true, originalBitrate, onChange, now = () => performance.now() }: QualityConfiguration & {
  onChange: (maxBitrate: number, reason: QualityReason) => void;
  now?: () => number;
}) {
  let ceiling = validBitrate(maxBitrate);
  let current = Math.min(ceiling, validBitrate(currentBitrate ?? ceiling));
  let original = current === ceiling && Number.isFinite(originalBitrate) && Number(originalBitrate) > 0 ? Number(originalBitrate) : undefined;
  let startedAt = now();
  let changedAt = -Infinity;
  let pending = false;
  let fast = 0;
  let slow = 0;
  let lastFragmentAt = -Infinity;
  let pressure = 0;
  let stalledSince: number | undefined;
  let healthySince: number | undefined;
  let recoveryFrom: number | undefined;
  let probeAfter = -Infinity;

  const levels = () => [...new Set([...ladder.filter(value => value <= ceiling), ceiling])].sort((a, b) => a - b);
  const bandwidth = () => Math.min(fast, slow);
  function change(next: number, reason: QualityReason) {
    if (pending || next === current) return;
    pending = true;
    changedAt = now();
    healthySince = undefined;
    stalledSince = undefined;
    pressure = 0;
    if (reason === 'recovery') recoveryFrom = current;
    onChange(next, reason);
  }
  function reduce(reason: 'bandwidth' | 'stall', stallBitrate?: number) {
    if (current <= 1500 || now() - changedAt < 20000) return;
    // Use measured capacity when possible. A live fair-share hint is only a
    // fallback after playback actually stalls, never an initial quality cap.
    const measured = measuredTransfers && bandwidth() > 0 && now() - lastFragmentAt < 15000;
    const fallback = Number.isFinite(stallBitrate) && Number(stallBitrate) > 0 ? validBitrate(Number(stallBitrate)) : Infinity;
    const throughputLimit = measured ? bandwidth() * 0.85 : fallback;
    const target = validBitrate(Math.min(recoveryFrom ?? Math.min(current, original ?? current) * 0.75, throughputLimit));
    if (recoveryFrom !== undefined) { recoveryFrom = undefined; probeAfter = now() + 300000; }
    change(target, reason);
  }

  return {
    configure(configuration: QualityConfiguration) {
      remote = configuration.remote;
      measuredTransfers = configuration.measuredTransfers ?? true;
      ceiling = validBitrate(configuration.maxBitrate);
      const accepted = Math.min(ceiling, validBitrate(configuration.currentBitrate ?? ceiling));
      if (accepted === ceiling) original = Number.isFinite(configuration.originalBitrate) && Number(configuration.originalBitrate) > 0 ? Number(configuration.originalBitrate) : undefined;
      // A replacement source needs its own bootstrap grace even when only
      // codec compatibility changed and its accepted quality stayed the same.
      startedAt = now();
      current = accepted;
      pending = false;
      pressure = 0;
      stalledSince = undefined;
      healthySince = undefined;
    },
    fragment({ bytes, downloadMs, duration, bufferAhead }: FragmentSample) {
      if (!remote || !measuredTransfers || ![bytes, downloadMs, duration, bufferAhead].every(Number.isFinite) || bytes <= 0 || downloadMs <= 0 || duration <= 0) return;
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
    sample({ playing, seeking, bufferAhead, stalled, stallBitrate, advancing }: PlaybackSample) {
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
        if (timestamp - stalledSince >= 5000) reduce('stall', stallBitrate);
        return;
      }
      stalledSince = undefined;
      if (pressure >= 3 && bufferAhead < 6 && timestamp - lastFragmentAt < 15000) {
        healthySince = undefined;
        reduce('bandwidth');
        return;
      }
      // A request cap can be much higher than the original video's demand.
      // Its original master bandwidth lets a recovered viewer return to that
      // output without first having to measure transfers at the unused cap.
      const originalSupported = original !== undefined && bandwidth() >= original * 1.1;
      const next = measuredTransfers
        ? levels().filter(value => value > current && (value >= current * 1.1 || value === ceiling) && (bandwidth() >= value * 1.1 || value === ceiling && originalSupported)).at(-1)
        : levels().find(value => value > current && (value >= current * 1.1 || value === ceiling));
      const healthy = measuredTransfers
        ? advancing !== false && bufferAhead >= 10 && timestamp - lastFragmentAt <= 15000
        : advancing === true;
      if (stalled || !healthy || pressure > 0) {
        healthySince = undefined;
        return;
      }
      healthySince ??= timestamp;
      if (timestamp - healthySince >= 60000 && timestamp - changedAt >= 60000) {
        recoveryFrom = undefined;
        // Advertised peak bandwidth can overstate the original's sustained
        // demand. A rare guarded probe avoids permanently retaining a cap.
        const candidate = next ?? (measuredTransfers && original !== undefined && current < ceiling && bandwidth() >= current * 1.1 && timestamp - healthySince >= 120000 ? ceiling : undefined);
        if (candidate && timestamp >= probeAfter) change(candidate, 'recovery');
      }
    },
  };
}
