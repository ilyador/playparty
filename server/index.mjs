import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import httpProxy from 'http-proxy';
import { WebSocketServer } from 'ws';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Party } from './party.mjs';
import { Plex } from './plex.mjs';
import { MovieBudget } from './bandwidth.mjs';
import { cookies, ownerAuthenticator, sessionId } from './auth.mjs';
import { authIdentity, PlexOwnerLogin } from './plex-auth.mjs';
import { playbackLogger, playbackMetrics } from './playback-log.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const ipv6Prefix = address => {
  const [left, right] = address.split('%')[0].split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  return [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after].slice(0, 4).map(n => n.padStart(4, '0')).join(':');
};
const localIPv6 = Object.values(networkInterfaces()).flat().filter(n => n?.family === 'IPv6' && !n.internal && !n.address.startsWith('fd') && n.cidr?.endsWith('/64')).map(n => ipv6Prefix(n.address));
const localNetwork = ip => {
  ip = String(ip || '').replace(/^::ffff:/, '');
  return ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || (ip.includes(':') && localIPv6.includes(ipv6Prefix(ip)));
};

export function createApp({ plex, authenticateOwner, plexLogin, livekitKey, livekitSecret, livekitUrl, livekitInternalUrl = 'http://127.0.0.1:7880', origin, loginUrl = '/api/auth/login', loginLabel = 'Sign in with Plex', movieMbps = 70, roomName = 'playparty', recordProgress = true, logPlayback = () => {}, assetsRoot = path.join(root, 'dist') } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const party = new Party();
  const sessions = new Map();
  const sockets = new Map();
  const callSockets = new Set();
  const playbackLocks = new Map();
  const budget = new MovieBudget(movieMbps);
  const call = livekitKey && livekitSecret ? new RoomServiceClient(livekitInternalUrl, livekitKey, livekitSecret) : null;
  const proxy = httpProxy.createProxyServer({ target: livekitInternalUrl, ws: true });
  proxy.on('error', (error, req, res) => {
    if (res.writeHead && !res.headersSent) { res.writeHead(502); res.end('The call server is unavailable.'); }
    else res.destroy();
  });
  let waitTimer;
  let selectionRevision = 0;
  let progressQueue = Promise.resolve();
  let progressSession = randomUUID();
  let lastProgressAt = 0;

  function saveProgress(state = party.paused ? 'paused' : 'playing') {
    if (!recordProgress || !party.movie || !plex.timeline) return Promise.resolve();
    const movie = party.movie;
    const position = Math.min(party.currentPosition(), movie.duration || Number.MAX_SAFE_INTEGER);
    const session = progressSession;
    lastProgressAt = Date.now();
    progressQueue = progressQueue.then(() => plex.timeline(movie, position, state, session))
      .catch(error => console.warn('Could not save Plex playback progress:', error.message));
    return progressQueue;
  }

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '4kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), fullscreen=(self)');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    const requestOrigin = req.headers.origin;
    if (!['GET', 'HEAD'].includes(req.method) && requestOrigin && ![origin, 'http://localhost:5175', 'http://localhost:5176', 'http://127.0.0.1:5175', 'http://127.0.0.1:5176'].includes(requestOrigin)) {
      return res.status(403).json({ error: 'Open Playparty from its own URL.' });
    }
    next();
  });

  function participant(req) { return sessions.get(cookies(req.headers.cookie).playparty_session); }
  function requireMember(req, res, next) {
    const member = participant(req);
    if (!member || !party.members.has(member.id)) return res.status(401).json({ error: 'Enter your name to join.' });
    req.member = member;
    member.lastSeen = Date.now();
    next();
  }
  async function requireHost(req, res, next) {
    if (!req.member?.owner || !await authenticateOwner(req.headers.cookie)) return res.status(403).json({ error: 'Only the Plex owner can choose what plays.' });
    next();
  }
  function broadcast() {
    const payload = JSON.stringify({ type: 'state', ...party.snapshot() });
    for (const socket of sockets.values()) if (socket.readyState === 1) socket.send(payload);
  }
  function armReadyTimeout() {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => {
      if (party.wantsPlay) logPlayback({ event: 'slow-start', mediaVersion: party.mediaVersion, position: party.position, ready: party.ready.size, members: party.members.size });
    }, 30000);
    waitTimer.unref();
  }

  app.get('/api/health', async (req, res) => {
    const plexReady = Boolean(plex?.token);
    let callReady = false;
    try { if (call) { await call.listRooms([roomName]); callReady = true; } } catch {}
    res.json({ plex: plexReady, call: callReady });
  });
  app.get('/api/session', async (req, res) => {
    res.json({ owner: Boolean(await authenticateOwner(req.headers.cookie)), loginUrl, loginLabel, plexLogin: Boolean(plexLogin), state: party.snapshot() });
  });
  if (plexLogin) {
    app.get('/api/auth/login', (req, res) => plexLogin.begin(req, res));
    app.post('/api/auth/complete', (req, res) => plexLogin.complete(req, res));
  }
  app.use((req, res, next) => {
    if (!req.url.startsWith('/livekit/')) return next();
    req.url = req.url.slice('/livekit'.length);
    delete req.headers.cookie;
    proxy.web(req, res);
  });
  app.post('/api/join', async (req, res) => {
    const authenticatedOwner = Boolean(await authenticateOwner(req.headers.cookie));
    if (req.body?.host === true && !authenticatedOwner) {
      return res.status(403).json({ error: 'Sign in as the Plex owner, then try again.' });
    }
    const owner = authenticatedOwner && req.body?.host !== false;
    const sid = sessionId(req, res, req.secure);
    const previous = sessions.get(sid);
    const member = party.join(req.body?.name, owner, sid);
    if (previous && previous.id !== member.id) {
      sockets.get(previous.id)?.close();
      party.members.delete(previous.id);
      await plex.stop(previous.id);
      call?.removeParticipant(roomName, previous.id).catch(() => {});
    }
    member.local = localNetwork(req.ip);
    member.device = /iphone/i.test(req.headers['user-agent'] || '') ? 'iphone' : /android/i.test(req.headers['user-agent'] || '') ? 'android' : 'desktop';
    sessions.set(sid, member);
    const token = new AccessToken(livekitKey, livekitSecret, { identity: member.id, name: member.name, ttl: '6h', metadata: JSON.stringify({ owner: member.owner }) });
    token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: [1, 2] });
    const callUrl = ['localhost', '127.0.0.1'].includes(req.hostname) ? `ws://${req.get('host')}/livekit` : livekitUrl;
    res.json({ identity: member.id, name: member.name, owner: member.owner, token: await token.toJwt(), livekitUrl: callUrl, state: party.snapshot() });
  });
  app.post('/api/leave', requireMember, async (req, res) => {
    const member = req.member;
    const progress = member.owner ? saveProgress('stopped') : Promise.resolve();
    sockets.get(member.id)?.close();
    party.members.delete(member.id);
    party.ready.delete(member.id);
    party.startIfReady();
    sessions.delete(cookies(req.headers.cookie).playparty_session);
    await plex.stop(member.id);
    await progress;
    call?.removeParticipant(roomName, member.id).catch(() => {});
    broadcast();
    res.json({ ok: true });
  });
  app.get('/api/library', requireMember, requireHost, async (req, res) => {
    const query = String(req.query.q || '');
    const parent = String(req.query.parent || '');
    const [items, continueWatching] = await Promise.all([
      plex.library({ query, parent }),
      !query && !parent && plex.continueWatching ? plex.continueWatching().catch(() => []) : [],
    ]);
    res.json({ items, continueWatching });
  });
  app.get('/api/image/:id', async (req, res) => {
    const owner = await authenticateOwner(req.headers.cookie);
    if (!owner && String(req.params.id) !== party.movie?.id) return res.sendStatus(404);
    const upstream = await plex.image(String(req.params.id), req.query.kind === 'art' ? 'art' : 'thumb');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(upstream.headers.get('content-type') || 'image/jpeg');
    await pipeline(Readable.fromWeb(upstream.body), res);
  });
  app.post('/api/select', requireMember, requireHost, async (req, res) => {
    const revision = ++selectionRevision;
    const item = await plex.metadata(String(req.body?.id || ''));
    if (revision !== selectionRevision) return res.status(409).json({ error: 'The selection changed. Choose again.' });
    if (!['movie', 'episode'].includes(item.type)) return res.status(400).json({ error: 'Choose a movie or an episode.' });
    const progress = saveProgress('stopped');
    progressSession = randomUUID();
    party.select(plex.simplify(item));
    logPlayback({ event: 'select', mediaVersion: party.mediaVersion, position: party.position });
    const stopping = Promise.all([...plex.streams.keys()].map(id => plex.stop(id)));
    armReadyTimeout();
    broadcast();
    await Promise.all([stopping, progress]);
    res.json(party.snapshot());
  });
  app.post('/api/stop', requireMember, requireHost, async (req, res) => {
    selectionRevision += 1;
    clearTimeout(waitTimer);
    const progress = saveProgress('stopped');
    party.stop();
    logPlayback({ event: 'stop', mediaVersion: party.mediaVersion });
    const stopping = Promise.all([...plex.streams.keys()].map(id => plex.stop(id)));
    broadcast();
    await Promise.all([stopping, progress]);
    res.json(party.snapshot());
  });
  app.post('/api/control', requireMember, requireHost, async (req, res) => {
    if (!['play', 'pause', 'seek'].includes(req.body?.action)) return res.status(400).json({ error: 'Unknown playback action.' });
    party.control(req.body.action, req.body.position);
    logPlayback({ event: 'control', action: req.body.action, mediaVersion: party.mediaVersion, position: party.currentPosition() });
    if (req.body.action !== 'pause') armReadyTimeout();
    broadcast();
    await saveProgress();
    res.json(party.snapshot());
  });
  app.post('/api/playback', requireMember, async (req, res) => {
    if (!party.movie) return res.status(404).json({ error: 'The host has not chosen anything yet.' });
    const count = Math.max(1, [...party.members.values()].filter(m => m.connected && !m.local).length);
    const remote = !req.member.local;
    const allowance = remote ? Math.max(1500, Math.floor(Number(movieMbps) * 1000 * 0.85 / count)) : 0;
    const requested = req.body?.maxBitrate;
    const currentBitrate = remote ? typeof requested === 'number' && Number.isFinite(requested) && requested >= 1500 ? Math.min(allowance, Math.floor(requested)) : allowance : 0;
    const qualityReason = ['bandwidth', 'stall', 'recovery'].includes(req.body?.qualityReason) ? req.body.qualityReason : 'initial';
    const version = party.mediaVersion;
    const previous = playbackLocks.get(req.member.id) || Promise.resolve();
    const start = previous.catch(() => {}).then(async () => {
      if (version !== party.mediaVersion) throw Object.assign(new Error('The movie changed. Reconnect to watch.'), { status: 409 });
      const result = await plex.start(req.member.id, { ...party.movie, version }, {
        position: party.currentPosition(), hevc: req.body?.hevc === true, maxBitrate: currentBitrate, remote, adaptive: remote && currentBitrate < allowance,
        subtitleId: typeof req.body?.subtitleId === 'string' ? req.body.subtitleId : '',
      });
      if (version !== party.mediaVersion) {
        await plex.stop(req.member.id);
        throw Object.assign(new Error('The movie changed. Reconnect to watch.'), { status: 409 });
      }
      return result;
    });
    playbackLocks.set(req.member.id, start);
    try {
      const result = await start;
      logPlayback({ event: 'stream-start', viewer: req.member.id, device: req.member.device, mediaVersion: version, position: party.currentPosition(), quality: result.quality, subtitleMode: result.subtitleMode, remote, maxBitrate: currentBitrate, qualityReason });
      const details = plex.streams.get(req.member.id)?.diagnostics;
      if (details) logPlayback({ event: 'stream-decision', viewer: req.member.id, mediaVersion: version, ...details });
      res.json({ ...result, mediaVersion: version, remote, maxBitrate: allowance, currentBitrate });
    } catch (error) { logPlayback({ event: 'stream-error', viewer: req.member.id, mediaVersion: version, status: error.status || 500 }); throw error; }
    finally { if (playbackLocks.get(req.member.id) === start) playbackLocks.delete(req.member.id); }
  });
  app.get('/api/stream/:resource', requireMember, async (req, res) => {
    const resource = plex.resources.get(String(req.params.resource));
    const stream = plex.streams.get(req.member.id);
    if (!resource || !stream || resource.streamId !== stream.id || stream.version !== party.mediaVersion) return res.sendStatus(404);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const upstream = await plex.request(resource.target, `playparty-${req.member.id}`, { signal: abort.signal, headers: req.headers.range ? { Range: req.headers.range } : {} });
    res.status(upstream.status);
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    res.type(type);
    if (type.includes('mpegurl') || /\.m3u8(?:\?|$)/i.test(resource.target)) {
      const text = await upstream.text();
      return res.send(plex.rewritePlaylist(text, new URL(resource.target, plex.url), stream));
    }
    for (const header of ['content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (req.member.local) await pipeline(Readable.fromWeb(upstream.body), res);
    else await pipeline(Readable.fromWeb(upstream.body), budget.limiter(), res);
  });

  server.on('upgrade', (req, socket, head) => {
    const session = sessions.get(cookies(req.headers.cookie).playparty_session);
    const allowedOrigin = !req.headers.origin || [origin, 'http://localhost:5175', 'http://localhost:5176', 'http://127.0.0.1:5175', 'http://127.0.0.1:5176'].includes(req.headers.origin);
    if (req.url.startsWith('/livekit/') && allowedOrigin) {
      callSockets.add(socket);
      socket.on('close', () => callSockets.delete(socket));
      req.url = req.url.slice('/livekit'.length);
      delete req.headers.cookie;
      return proxy.ws(req, socket, head);
    }
    if (req.url !== '/events' || !session || !party.members.has(session.id) || !allowedOrigin) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.get(session.id)?.close();
      sockets.set(session.id, ws);
      session.connected = true;
      session.lastSeen = Date.now();
      party.ready.delete(session.id);
      if (party.movie && party.buffering(session.id, party.mediaVersion)) logPlayback({ event: 'join-wait', viewer: session.id, mediaVersion: party.mediaVersion, position: party.position });
      ws.on('message', raw => {
        if (sockets.get(session.id) !== ws || !party.members.has(session.id)) return;
        try {
          const message = JSON.parse(raw.toString());
          session.lastSeen = Date.now();
          if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong', sent: message.sent, serverTime: Date.now() }));
          if (message.type === 'ready') {
            const paused = party.paused;
            party.markReady(session.id, Number(message.mediaVersion));
            logPlayback({ event: paused && !party.paused ? 'shared-resume' : 'viewer-ready', viewer: session.id, mediaVersion: party.mediaVersion, position: party.position });
            broadcast();
          }
          if (message.type === 'buffering' && party.buffering(session.id, Number(message.mediaVersion))) {
            logPlayback({ event: 'shared-buffering', viewer: session.id, mediaVersion: party.mediaVersion, position: party.position });
            if (plex.transcodeMetrics && Date.now() - (session.lastTranscodeSample || 0) > 10000) {
              session.lastTranscodeSample = Date.now();
              plex.transcodeMetrics(session.id).then(metrics => logPlayback({ event: 'plex-transcode', viewer: session.id, mediaVersion: party.mediaVersion, ...metrics })).catch(() => {});
            }
            broadcast();
          }
          if (message.type === 'telemetry') {
            const metrics = playbackMetrics(message);
            const diagnostic = metrics && /^(capture-|microphone-|call-audio-|movie-audio)/.test(metrics.event);
            if (diagnostic) {
              const now = Date.now();
              if (!session.deviceTelemetry || now - session.deviceTelemetry.since >= 1000) session.deviceTelemetry = { since: now, count: 0, seen: new Map() };
              const key = JSON.stringify(metrics);
              if (session.deviceTelemetry.count < 12 && session.deviceTelemetry.seen.get(metrics.event) !== key) {
                session.deviceTelemetry.count++; session.deviceTelemetry.seen.set(metrics.event, key);
                logPlayback({ ...metrics, viewer: session.id, device: session.device });
              }
            } else if (metrics && Date.now() - (session.lastTelemetryAt || 0) >= 1000) {
              session.lastTelemetryAt = Date.now(); logPlayback({ ...metrics, viewer: session.id, device: session.device });
            }
          }
        } catch {}
      });
      ws.on('close', () => {
        if (sockets.get(session.id) !== ws) return;
        sockets.delete(session.id);
        session.connected = false;
        session.lastSeen = Date.now();
        party.startIfReady();
        broadcast();
      });
      broadcast();
    });
  });
  const ticker = setInterval(() => {
    const now = Date.now();
    if (party.members.get('owner')?.connected && now - lastProgressAt >= 10000) saveProgress();
    for (const [sid, member] of sessions) {
      if ((!member.connected && now - member.lastSeen > 45000) || now - member.lastSeen > 90000) {
        sockets.get(member.id)?.close();
        sockets.delete(member.id);
        party.members.delete(member.id);
        party.startIfReady();
        sessions.delete(sid);
        plex.stop(member.id).catch(() => {});
        call?.removeParticipant(roomName, member.id).catch(() => {});
      }
    }
    broadcast();
  }, 2000);
  ticker.unref();
  server.on('close', () => { clearInterval(ticker); clearTimeout(waitTimer); wss.close(); });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown request.' }));
  app.use(express.static(assetsRoot, { maxAge: '1h', index: false }));
  app.get('/{*splat}', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(assetsRoot, 'index.html'));
  });
  app.use((error, req, res, next) => {
    if (res.headersSent || res.destroyed) return;
    if (error.name === 'AbortError') return res.status(499).end();
    console.error('Playparty request:', error.message);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong. Try again.' });
  });
  const close = async () => {
    clearInterval(ticker); clearTimeout(waitTimer);
    for (const socket of wss.clients) socket.close(1001, 'Server restarting');
    for (const socket of callSockets) socket.destroy();
    await Promise.all([saveProgress('stopped'), ...[...plex.streams.keys()].map(id => plex.stop(id))]);
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    for (const socket of wss.clients) socket.terminate();
    proxy.close();
    await closed;
  };
  return { app, server, party, sessions, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plex = new Plex({ url: process.env.PLEX_URL, preferences: process.env.PLEX_PREFERENCES, token: process.env.PLEX_TOKEN, ownerEmail: process.env.PLEX_OWNER_EMAIL });
  const origin = process.env.PUBLIC_URL || 'http://localhost:5175';
  const authMode = process.env.AUTH_MODE || 'plex';
  if (!['plex', 'external'].includes(authMode)) throw new Error('AUTH_MODE must be plex or external.');
  if (authMode === 'external' && (!process.env.AUTH_URL || !process.env.AUTH_COOKIE_NAMES || !plex.ownerEmail)) {
    throw new Error('External authentication requires AUTH_URL, AUTH_COOKIE_NAMES and the Plex owner email.');
  }
  const plexLogin = authMode === 'plex' ? new PlexOwnerLogin({ ownerEmail: plex.ownerEmail, origin,
    identity: authIdentity(path.join(root, 'data', 'owner-auth.json')) }) : null;
  const authenticateOwner = plexLogin?.authenticate || ownerAuthenticator(process.env.AUTH_URL, plex.ownerEmail, process.env.AUTH_COOKIE_NAMES.split(',').map(name => name.trim()));
  let livekit;
  if (process.env.LIVEKIT_MANAGED === 'true') {
    livekit = spawn(path.join(root, 'bin', 'livekit-server'), ['--config', path.join(root, 'data', 'livekit.yaml')], { stdio: 'inherit' });
  }
  const { server, close } = createApp({
    plex, authenticateOwner, plexLogin, origin, loginUrl: process.env.AUTH_LOGIN_URL, loginLabel: process.env.AUTH_LOGIN_LABEL,
    livekitKey: process.env.LIVEKIT_API_KEY, livekitSecret: process.env.LIVEKIT_API_SECRET,
    livekitUrl: process.env.LIVEKIT_PUBLIC_URL || `${origin.replace(/^http/, 'ws')}/livekit`, livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL,
    movieMbps: Number(process.env.MOVIE_UPLOAD_MBPS || 70),
    logPlayback: playbackLogger(path.join(root, 'data', 'playback.log')),
  });
  server.listen(Number(process.env.PORT || 5175), process.env.BIND_ADDRESS || '127.0.0.1', () => console.log(`Playparty listening on ${process.env.BIND_ADDRESS || '127.0.0.1'}:${process.env.PORT || 5175}`));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    close().finally(() => { livekit?.kill('SIGTERM'); process.exit(process.exitCode || 0); });
  };
  livekit?.on('exit', () => { if (!shuttingDown) { console.error('LiveKit stopped.'); process.exitCode = 1; shutdown(); } });
  livekit?.on('error', () => { console.error('LiveKit could not start. Run npm run setup.'); process.exitCode = 1; shutdown(); });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
