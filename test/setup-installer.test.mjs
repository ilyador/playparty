import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { compatibleLivekitVersion, installLivekit, livekitInstaller } from '../deploy/setup.mjs';

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'playparty-installer-test-'));
}

test('LiveKit installation selects real Linux release assets and native Homebrew on both Mac architectures', () => {
  assert.deepEqual(livekitInstaller('linux', 'x64'), { kind: 'release', name: 'livekit_1.13.9_linux_amd64.tar.gz' });
  assert.deepEqual(livekitInstaller('linux', 'arm64'), { kind: 'release', name: 'livekit_1.13.9_linux_arm64.tar.gz' });
  for (const arch of ['x64', 'arm64']) assert.deepEqual(livekitInstaller('darwin', arch), { kind: 'homebrew' });
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'arm'], ['darwin', 'ia32']]) {
    assert.throws(() => livekitInstaller(platform, arch), /supports Linux and macOS on x64 or arm64/);
  }
});

test('Homebrew accepts tested LiveKit and later 1.x releases, rejecting older or incompatible binaries', () => {
  for (const version of ['1.13.9', '1.13.10', '1.14.0', '1.99.0']) assert.equal(compatibleLivekitVersion(`livekit-server version ${version}\n`), true);
  for (const version of ['1.13.8', '1.12.99', '0.13.9', '2.0.0', '1.13.9-dev', 'unknown']) assert.equal(compatibleLivekitVersion(`livekit-server version ${version}\n`), false);
  assert.equal(compatibleLivekitVersion('another-program version 1.13.9'), false);
});

for (const arch of ['x64', 'arm64']) test(`macOS ${arch} installs and manages the binary from Homebrew's resolved prefix`, async () => {
  const directory = temporaryDirectory();
  try {
    const prefix = path.join(directory, 'homebrew', arch);
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    const binary = path.join(prefix, 'bin', 'livekit-server');
    fs.writeFileSync(binary, `native ${arch} binary fixture`);
    fs.writeFileSync(path.join(directory, '.env'), 'private configuration fixture\n');
    const calls = [];
    await installLivekit(directory, { platform: 'darwin', arch, fetcher: () => { throw new Error('macOS must use Homebrew rather than Linux downloads'); }, run: (command, args, options) => {
      calls.push([command, args]);
      if (command === 'brew' && args[0] === '--version') return '';
      if (command === 'brew' && args[0] === 'install') { assert.equal(options.stdio, 'inherit'); return ''; }
      if (command === 'brew' && args[0] === '--prefix') return `${prefix}\n`;
      assert.equal(command, binary);
      assert.deepEqual(args, ['--version']);
      return 'livekit-server version 1.14.0\n';
    } });
    assert.deepEqual(calls, [['brew', ['--version']], ['brew', ['install', 'livekit']], ['brew', ['--prefix', 'livekit']], [binary, ['--version']]]);
    const installed = path.join(directory, 'bin', 'livekit-server');
    assert.equal(fs.readFileSync(installed, 'utf8'), `native ${arch} binary fixture`);
    assert.equal(fs.statSync(installed).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), 'private configuration fixture\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('macOS installation gives actionable errors when Homebrew is missing or fails', async () => {
  const directory = temporaryDirectory();
  try {
    await assert.rejects(installLivekit(directory, { platform: 'darwin', arch: 'arm64', run: () => { throw Object.assign(new Error('missing command'), { code: 'ENOENT' }); } }), /Install it from https:\/\/brew.sh, then run npm run setup again/);
    await assert.rejects(installLivekit(directory, { platform: 'darwin', arch: 'x64', run: (command, args) => { if (args[0] === 'install') throw new Error('install failed'); return ''; } }), /Run brew install livekit to resolve the error/);
    assert.equal(fs.existsSync(path.join(directory, 'bin')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('macOS rejects invalid prefixes and old binaries before copying them', async () => {
  const directory = temporaryDirectory();
  try {
    const run = prefix => (command, args) => args[0] === '--prefix' ? prefix : args[0] === '--version' && command !== 'brew' ? 'livekit-server version 1.13.8' : '';
    await assert.rejects(installLivekit(directory, { platform: 'darwin', arch: 'arm64', run: run('relative/path') }), /invalid LiveKit installation path/);
    await assert.rejects(installLivekit(directory, { platform: 'darwin', arch: 'x64', run: run(directory) }), /Run brew upgrade livekit/);
    assert.equal(fs.existsSync(path.join(directory, 'bin')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const arch of ['x64', 'arm64']) test(`Linux ${arch} verifies, extracts, and cleans its pinned release archive`, async () => {
  const directory = temporaryDirectory();
  try {
    const fixture = path.join(directory, 'fixture');
    const downloads = path.join(directory, 'downloads');
    fs.mkdirSync(fixture); fs.mkdirSync(downloads);
    fs.writeFileSync(path.join(fixture, 'livekit-server'), 'release binary fixture');
    const archivePath = path.join(directory, 'fixture.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', fixture, 'livekit-server']);
    const archive = fs.readFileSync(archivePath);
    const name = livekitInstaller('linux', arch).name;
    const checksum = `${createHash('sha256').update(archive).digest('hex')}  ${name}\n`;
    const urls = [];
    await installLivekit(directory, { platform: 'linux', arch, temporaryDirectory: downloads, fetcher: async url => {
      urls.push(url);
      return new Response(url.endsWith('/checksums.txt') ? checksum : archive);
    } });
    assert.deepEqual(urls.sort(), [`https://github.com/livekit/livekit/releases/download/v1.13.9/${name}`, 'https://github.com/livekit/livekit/releases/download/v1.13.9/checksums.txt'].sort());
    const installed = path.join(directory, 'bin', 'livekit-server');
    assert.equal(fs.readFileSync(installed, 'utf8'), 'release binary fixture');
    assert.equal(fs.statSync(installed).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(downloads), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Linux download and checksum failures preserve the existing binary without extracting anything', async () => {
  const directory = temporaryDirectory();
  try {
    fs.mkdirSync(path.join(directory, 'bin'));
    const installed = path.join(directory, 'bin', 'livekit-server');
    fs.writeFileSync(installed, 'existing binary');
    const name = livekitInstaller('linux', 'x64').name;
    const options = { platform: 'linux', arch: 'x64', run: () => { throw new Error('an unverified archive must not be extracted'); } };
    for (const checksum of ['', `invalid  ${name}`, `${'0'.repeat(64)}  ${name}`, `${'0'.repeat(64)}  another-archive.tar.gz`]) {
      await assert.rejects(installLivekit(directory, { ...options, fetcher: async url => new Response(url.endsWith('/checksums.txt') ? checksum : 'archive fixture') }), /checksum verification failed/);
    }
    await assert.rejects(installLivekit(directory, { ...options, fetcher: async () => new Response('', { status: 404 }) }), /download failed \(404\)/);
    assert.equal(fs.readFileSync(installed, 'utf8'), 'existing binary');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Linux extraction failures clean temporary downloads', async () => {
  const directory = temporaryDirectory();
  try {
    const downloads = path.join(directory, 'downloads');
    fs.mkdirSync(downloads);
    const archive = Buffer.from('verified but invalid archive fixture');
    const name = livekitInstaller('linux', 'arm64').name;
    const checksum = `${createHash('sha256').update(archive).digest('hex')}  ${name}\n`;
    await assert.rejects(installLivekit(directory, { platform: 'linux', arch: 'arm64', temporaryDirectory: downloads, fetcher: async url => new Response(url.endsWith('/checksums.txt') ? checksum : archive), run: (command, args) => {
      assert.equal(command, 'tar');
      assert.ok(fs.existsSync(args[1]));
      throw new Error('extraction failed');
    } }), /extraction failed/);
    assert.deepEqual(fs.readdirSync(downloads), []);
    assert.equal(fs.existsSync(path.join(directory, 'bin')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
