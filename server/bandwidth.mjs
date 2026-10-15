import { Transform } from 'node:stream';

// One paced budget for all movie responses, including parallel segment requests.
// Camera/microphone traffic goes directly through LiveKit and keeps the remainder.
export class MovieBudget {
  constructor(mbps) {
    this.bytesPerSecond = Math.max(1, Number(mbps) || 70) * 1_000_000 / 8;
    this.nextAt = 0;
    this.pending = [];
    this.timer = undefined;
  }
  schedule() {
    if (this.timer || !this.pending.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const entry = this.pending.shift();
      // Only delivered chunks spend the budget. Abandoned readers must not
      // reserve future bandwidth that the remaining viewers cannot use.
      this.nextAt = Math.max(Date.now(), this.nextAt) + entry.bytes / this.bytesPerSecond * 1000;
      entry.deliver();
      this.schedule();
    }, Math.max(0, this.nextAt - Date.now()));
  }
  limiter() {
    const budget = this;
    let queued;
    return new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk, encoding, callback) {
        queued = { bytes: chunk.length, deliver() { queued = undefined; callback(null, chunk); } };
        budget.pending.push(queued);
        budget.schedule();
      },
      destroy(error, callback) {
        const index = budget.pending.indexOf(queued);
        if (index !== -1) {
          budget.pending.splice(index, 1);
          queued = undefined;
          if (index === 0) {
            clearTimeout(budget.timer);
            budget.timer = undefined;
            budget.schedule();
          }
        }
        callback(error);
      },
    });
  }
}
