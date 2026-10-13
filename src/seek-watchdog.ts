// Some media engines keep HAVE_ENOUGH_DATA while a seek never completes.
// Treat that as buffering, and replace the source only once data has arrived.
export function seekWatchdog() {
  let started: number | undefined;
  return {
    sample(now: number, seeking: boolean, hasFutureData: boolean) {
      if (!seeking) { started = undefined; return { stalled: false, reload: false }; }
      started ??= now;
      const elapsed = Math.max(0, now - started);
      return { stalled: elapsed >= 1500, reload: elapsed >= 8000 && hasFutureData };
    },
    reset() { started = undefined; },
  };
}
