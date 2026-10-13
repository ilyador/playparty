import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { Plex } from '../server/plex.mjs';

const version = '1.13.9';
const release = `https://github.com/livekit/livekit/releases/download/v${version}`;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function writeConfiguration(directory, { publicUrl, plexUrl, token, ownerEmail, preferences = '' }) {
  const data = path.join(directory, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  const url = new URL(publicUrl);
  const port = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? url.port || '5175' : '5175';
  const config = { PUBLIC_URL: publicUrl, BIND_ADDRESS: '127.0.0.1', PORT: port, PLEX_URL: plexUrl,
    PLEX_OWNER_EMAIL: ownerEmail, ...(preferences ? { PLEX_PREFERENCES: preferences } : { PLEX_TOKEN: token }),
    AUTH_MODE: 'plex', LIVEKIT_MANAGED: 'true', LIVEKIT_API_KEY: 'playparty', LIVEKIT_API_SECRET: secret,
    MOVIE_UPLOAD_MBPS: '70' };
  const yaml = `port: 7880\nbind_addresses:\n  - 127.0.0.1\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: true\nkeys:\n  playparty: ${secret}\nlogging:\n  level: warn\n`;
  fs.writeFileSync(path.join(data, 'livekit.yaml'), yaml, { mode: 0o600, flag: 'wx' });
  try {
    fs.writeFileSync(path.join(directory, '.env'), Object.entries(config).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) { fs.unlinkSync(path.join(data, 'livekit.yaml')); throw error; }
}

export async function installLivekit(directory) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Automatic setup supports Linux x64 and arm64. Install LiveKit manually on other platforms.');
  const name = `livekit_${version}_linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`;
  const download = async name => {
    const response = await fetch(`${release}/${name}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`LiveKit download failed (${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  };
  const [archive, checksums] = await Promise.all([download(name), download('checksums.txt')]);
  const expected = checksums.toString().split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === name)?.[0];
  if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('LiveKit checksum verification failed.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'playparty-livekit-'));
  try {
    fs.writeFileSync(path.join(temp, name), archive);
    execFileSync('tar', ['-xzf', path.join(temp, name), '-C', temp, 'livekit-server']);
    fs.mkdirSync(path.join(directory, 'bin'), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(temp, 'livekit-server'), path.join(directory, 'bin', 'livekit-server'));
    fs.chmodSync(path.join(directory, 'bin', 'livekit-server'), 0o700);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function setup() {
  if (fs.existsSync(path.join(root, '.env'))) throw new Error('.env already exists. Edit it directly; setup will not replace your configuration.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const ask = async (prompt, fallback = '') => (await rl.question(`${prompt}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
  try {
    const publicUrl = await ask('Playparty URL (use HTTPS for remote guests)', 'http://localhost:5175');
    const url = new URL(publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a plain HTTP or HTTPS address, without a path or credentials.');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote guests need an HTTPS address for camera and microphone access.');
    const plexUrl = await ask('Plex server URL', 'http://127.0.0.1:32400');
    const pms = new URL(plexUrl);
    if (!['http:', 'https:'].includes(pms.protocol) || pms.username || pms.password) throw new Error('Use an HTTP or HTTPS Plex server URL.');
    const standardPreferences = '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml';
    let readablePreferences = '';
    try { fs.accessSync(standardPreferences, fs.constants.R_OK); readablePreferences = standardPreferences; } catch {}
    const preferences = await ask('Preferences.xml path (leave empty to use a Plex token)', readablePreferences);
    let token;
    if (!preferences) {
      process.stdout.write('Plex owner token (hidden): '); muted = true;
      token = (await rl.question('')).trim(); muted = false; process.stdout.write('\n');
    }
    const plex = new Plex({ url: plexUrl, preferences, token });
    const [profileResponse, account] = await Promise.all([
      fetch('https://plex.tv/api/v2/user', { headers: { Accept: 'application/json', 'X-Plex-Token': plex.token, 'X-Plex-Client-Identifier': 'playparty-setup' }, signal: AbortSignal.timeout(10000) }),
      plex.request('/myplex/account').then(response => response.json()),
    ]);
    if (!profileResponse.ok) throw new Error('The Plex token could not be verified. Use the server owner’s token.');
    const profile = await profileResponse.json();
    const owner = String(account.MyPlex?.username || '').trim().toLowerCase();
    if (!profile.email || !owner || ![profile.email, profile.username].some(value => String(value || '').trim().toLowerCase() === owner)) throw new Error('This account does not own the selected Plex server.');
    await plex.json('/library/sections');
    console.log('Installing LiveKit and checking its release checksum…');
    await installLivekit(root);
    writeConfiguration(root, { publicUrl: url.origin, plexUrl, preferences, token: plex.token, ownerEmail: profile.email });
    console.log(`Ready. Run npm start, then open ${url.origin}.`);
  } finally { rl.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) setup().catch(error => { console.error(error.message); process.exitCode = 1; });
