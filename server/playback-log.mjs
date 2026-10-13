import fs from 'node:fs';
import path from 'node:path';

const events = new Set(['sample', 'waiting', 'playing', 'ready', 'correction', 'fatal', 'needs-gesture']);
const numeric = ['mediaVersion', 'position', 'target', 'drift', 'bufferAhead', 'readyState', 'rate'];
export function playbackMetrics(message) {
  if (!events.has(message.event)) return null;
  const result = { event: message.event };
  for (const key of numeric) if (Number.isFinite(message[key]) && Math.abs(message[key]) <= 1e7) result[key] = Math.round(message[key] * 1000) / 1000;
  for (const key of ['paused', 'waiting', 'seeking']) if (typeof message[key] === 'boolean') result[key] = message[key];
  return result;
}

export function playbackLogger(filename, { maxBytes = 2 * 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, '', { mode: 0o600, flag: 'a' });
  let bytes = fs.existsSync(filename) ? fs.statSync(filename).size : 0;
  if (fs.existsSync(filename)) fs.chmodSync(filename, 0o600);
  return event => {
    try {
      const line = JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n';
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        fs.rmSync(`${filename}.2`, { force: true });
        if (fs.existsSync(`${filename}.1`)) fs.renameSync(`${filename}.1`, `${filename}.2`);
        if (fs.existsSync(filename)) fs.renameSync(filename, `${filename}.1`);
        bytes = 0;
      }
      fs.appendFileSync(filename, line, { mode: 0o600 });
      bytes += Buffer.byteLength(line);
    } catch (error) { console.warn('Playback log could not be written:', error.code); }
  };
}
