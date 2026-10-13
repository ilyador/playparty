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

export function writeConfiguration(directory, { publicUrl, plexUrl, token, preferences = '' }) {
  const data = path.join(directory, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  const url = new URL(publicUrl);
  const port = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? url.port || '5175' : '5175';
  const config = { PUBLIC_URL: publicUrl, BIND_ADDRESS: '127.0.0.1', PORT: port, PLEX_URL: plexUrl,
    ...(preferences ? { PLEX_PREFERENCES: preferences } : token ? { PLEX_TOKEN: token } : {}),
    AUTH_MODE: 'network', LOCAL_AUTH: 'false', LIVEKIT_MANAGED: 'true', LIVEKIT_API_KEY: 'playparty', LIVEKIT_API_SECRET: secret,
    MOVIE_UPLOAD_MBPS: '70' };
  const yaml = `port: 7880\nbind_addresses:\n  - 127.0.0.1\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: true\nkeys:\n  playparty: ${secret}\nlogging:\n  level: warn\n`;
  fs.writeFileSync(path.join(data, 'livekit.yaml'), yaml, { mode: 0o600, flag: 'wx' });
  try {
    fs.writeFileSync(path.join(directory, '.env'), Object.entries(config).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) { fs.unlinkSync(path.join(data, 'livekit.yaml')); throw error; }
}

export function livekitInstaller(platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Automatic setup supports Linux and macOS on x64 or arm64.');
  return platform === 'darwin' ? { kind: 'homebrew' } : { kind: 'release', name: `livekit_${version}_linux_${arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz` };
}

export function compatibleLivekitVersion(output) {
  const match = String(output).match(/\blivekit-server version (\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 1 && (minor > 13 || minor === 13 && patch >= 9);
}

export async function installLivekit(directory, { platform = process.platform, arch = process.arch, fetcher = fetch, run = execFileSync, temporaryDirectory = os.tmpdir() } = {}) {
  const installer = livekitInstaller(platform, arch);
  const destination = path.join(directory, 'bin', 'livekit-server');
  const copyBinary = source => {
    if (!fs.statSync(source).isFile()) throw new Error('LiveKit installation did not produce a server binary.');
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o700);
  };
  if (installer.kind === 'homebrew') {
    try { run('brew', ['--version'], { stdio: 'ignore' }); }
    catch { throw new Error('macOS setup needs Homebrew. Install it from https://brew.sh, then run npm run setup again.'); }
    try { run('brew', ['install', 'livekit'], { stdio: 'inherit' }); }
    catch { throw new Error('Homebrew could not install LiveKit. Run brew install livekit to resolve the error, then run npm run setup again.'); }
    const prefix = run('brew', ['--prefix', 'livekit'], { encoding: 'utf8' }).trim();
    if (!path.isAbsolute(prefix)) throw new Error('Homebrew returned an invalid LiveKit installation path.');
    const binary = path.join(prefix, 'bin', 'livekit-server');
    const installedVersion = run(binary, ['--version'], { encoding: 'utf8' });
    if (!compatibleLivekitVersion(installedVersion)) throw new Error(`LiveKit 1.13.9 or a newer 1.x release is required. Run brew upgrade livekit, then run npm run setup again.`);
    copyBinary(binary);
    return;
  }
  const { name } = installer;
  const download = async name => {
    const response = await fetcher(`${release}/${name}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`LiveKit download failed (${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  };
  const [archive, checksums] = await Promise.all([download(name), download('checksums.txt')]);
  const expected = checksums.toString().split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === name)?.[0];
  if (!/^[a-f0-9]{64}$/.test(expected || '') || createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('LiveKit checksum verification failed.');
  const temp = fs.mkdtempSync(path.join(temporaryDirectory, 'playparty-livekit-'));
  try {
    fs.writeFileSync(path.join(temp, name), archive);
    run('tar', ['-xzf', path.join(temp, name), '-C', temp, 'livekit-server']);
    copyBinary(path.join(temp, 'livekit-server'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function setup() {
  if (fs.existsSync(path.join(root, '.env'))) throw new Error('.env already exists. Edit it directly; setup will not replace your configuration.');
  livekitInstaller();
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
    const preferences = process.platform === 'linux' ? await ask('Preferences.xml path (leave empty to use a Plex token)', readablePreferences) : '';
    let token;
    if (!preferences) {
      process.stdout.write('Plex token (hidden): '); muted = true;
      token = (await rl.question('')).trim(); muted = false; process.stdout.write('\n');
    }
    const plex = new Plex({ url: plexUrl, preferences, token });
    if (!await plex.canAccess()) throw new Error('Plex is unavailable or the token cannot access its libraries. Check the server address and token.');
    console.log(process.platform === 'darwin' ? 'Installing LiveKit with Homebrew…' : 'Installing LiveKit and checking its release checksum…');
    await installLivekit(root);
    writeConfiguration(root, { publicUrl: url.origin, plexUrl, preferences, token: plex.token });
    console.log(`Ready. Run npm start, then open ${url.origin}.`);
  } finally { rl.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) setup().catch(error => { console.error(error.message); process.exitCode = 1; });
