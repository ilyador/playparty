import fs from 'node:fs';
import path from 'node:path';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual } from 'node:crypto';
import { cookies } from './auth.mjs';

const lifetime = 86400;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function authIdentity(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filename)) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const id = randomUUID();
    const identity = { id, secret: randomBytes(32).toString('hex'),
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      jwk: { ...publicKey.export({ format: 'jwk' }), kid: id, alg: 'EdDSA' } };
    try { fs.writeFileSync(filename, JSON.stringify(identity), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  fs.chmodSync(filename, 0o600);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

export class PlexOwnerLogin {
  constructor({ ownerEmail, identity, origin, fetcher = fetch }) {
    if (!ownerEmail) throw new Error('The Plex owner email is required for host sign-in.');
    this.email = ownerEmail.trim().toLowerCase();
    this.identity = identity;
    this.origin = origin;
    this.fetcher = fetcher;
    this.pending = new Map();
    this.attempts = new Map();
  }

  signature(value) { return createHmac('sha256', this.identity.secret).update(value).digest('base64url'); }
  authenticate = async (header = '') => {
    const [payload, signature] = (cookies(header).playparty_owner || '').split('.');
    if (!payload || !signature || signature.length !== 43) return false;
    const expected = Buffer.from(this.signature(payload));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return false;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return session.email === this.email && session.exp > Date.now() / 1000;
    } catch { return false; }
  };

  cookie(name, value, secure, seconds) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  }

  async request(endpoint, options = {}, token) {
    const response = await this.fetcher(endpoint, { ...options,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        'X-Plex-Client-Identifier': this.identity.id, 'X-Plex-Product': 'Playparty',
        ...(token ? { 'X-Plex-Token': token } : {}) }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Object.assign(new Error('Plex sign-in is unavailable. Try again.'), { status: 502 });
    return response.json();
  }

  async begin(req, res) {
    const now = Date.now();
    for (const [id, pin] of this.pending) if (pin.expires < now) this.pending.delete(id);
    for (const [ip, attempt] of this.attempts) if (attempt.until < now) this.attempts.delete(ip);
    const attempt = this.attempts.get(req.ip) || { count: 0, until: now + 600000 };
    if (attempt.count >= 10 || this.pending.size >= 64) throw Object.assign(new Error('Too many sign-in attempts. Try again later.'), { status: 429 });
    attempt.count++; this.attempts.set(req.ip, attempt);
    const pin = await this.request('https://clients.plex.tv/api/v2/pins', {
      method: 'POST', body: JSON.stringify({ jwk: this.identity.jwk, strong: true }) });
    if (!pin.id || !pin.code) throw Object.assign(new Error('Plex could not start sign-in. Try again.'), { status: 502 });
    const previous = cookies(req.headers.cookie).playparty_login;
    if (previous) this.pending.delete(previous);
    const state = randomBytes(32).toString('base64url');
    this.pending.set(state, { id: pin.id, expires: now + 600000 });
    res.setHeader('Set-Cookie', this.cookie('playparty_login', state, req.secure, 600));
    const params = new URLSearchParams({ clientID: this.identity.id, code: pin.code,
      'context[device][product]': 'Playparty', forwardUrl: new URL('/?plex-login=1', this.origin).href });
    res.redirect(`https://app.plex.tv/auth#?${params}`);
  }

  async complete(req, res) {
    const state = cookies(req.headers.cookie).playparty_login;
    const pin = this.pending.get(state);
    if (!pin || pin.expires < Date.now()) {
      this.pending.delete(state);
      return res.status(401).json({ error: 'Sign-in expired. Please sign in again.' });
    }
    // A pending PIN belongs only to this browser's HttpOnly cookie. Never accept
    // an account token or PIN supplied in the callback URL or request body.
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: this.identity.id })}.${encode({ aud: 'plex.tv', iss: this.identity.id, scope: 'username,email', iat: now, exp: now + 300 })}`;
    const jwt = `${unsigned}.${sign(null, Buffer.from(unsigned), this.identity.privateKey).toString('base64url')}`;
    const result = await this.request(`https://clients.plex.tv/api/v2/pins/${encodeURIComponent(pin.id)}?deviceJWT=${encodeURIComponent(jwt)}`);
    if (!result.authToken) return res.status(401).json({ error: 'Finish signing into Plex, then try again.' });
    this.pending.delete(state);
    const user = await this.request('https://plex.tv/api/v2/user', {}, result.authToken);
    if (String(user.email || '').trim().toLowerCase() !== this.email) {
      res.setHeader('Set-Cookie', this.cookie('playparty_login', '', req.secure, 0));
      return res.status(403).json({ error: 'Sign in with the account that owns this Plex server.' });
    }
    const payload = encode({ email: this.email, exp: now + lifetime });
    res.setHeader('Set-Cookie', [this.cookie('playparty_owner', `${payload}.${this.signature(payload)}`, req.secure, lifetime),
      this.cookie('playparty_login', '', req.secure, 0)]);
    res.json({ owner: true });
  }
}
