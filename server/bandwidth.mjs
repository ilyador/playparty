import { Transform } from 'node:stream';

// One paced budget for all movie responses, including parallel segment requests.
// Camera/microphone traffic goes directly through LiveKit and keeps the remainder.
export class MovieBudget {
  constructor(mbps) {
    this.bytesPerSecond = Math.max(1, Number(mbps) || 70) * 1_000_000 / 8;
    this.nextAt = 0;
  }
  limiter() {
    const budget = this;
    let timer;
    return new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk, encoding, callback) {
        const now = Date.now();
        const at = Math.max(now, budget.nextAt);
        budget.nextAt = at + chunk.length / budget.bytesPerSecond * 1000;
        timer = setTimeout(() => callback(null, chunk), Math.max(0, at - now));
      },
      destroy(error, callback) { clearTimeout(timer); callback(error); },
    });
  }
}
