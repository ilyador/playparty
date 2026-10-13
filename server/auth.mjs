import { randomUUID } from 'node:crypto';

export function cookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    try { result[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return result;
}

export function ownerAuthenticator(url, cookieNames = ['owner_session']) {
  return async (header = '') => {
    const authCookies = header.split(';').map(cookie => cookie.trim()).filter(cookie => cookieNames.includes(cookie.split('=', 1)[0])).join('; ');
    if (!authCookies) return false;
    try {
      const response = await fetch(url, { headers: { Cookie: authCookies, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (!response.ok) return false;
      const session = await response.json();
      return session.authenticated === true;
    } catch { return false; }
  };
}

export function sessionId(req, res, secure = false) {
  const existing = cookies(req.headers.cookie).playparty_session;
  const id = /^[a-f0-9-]{36}$/.test(existing || '') ? existing : randomUUID();
  if (id !== existing) res.setHeader('Set-Cookie', `playparty_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`);
  return id;
}
