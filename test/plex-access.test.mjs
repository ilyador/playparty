import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Plex } from '../server/plex.mjs';

async function fixture(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const plex = new Plex({ url: `http://127.0.0.1:${server.address().port}`, token: 'fixture-access-token' });
  return { plex, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('Plex access probes the authorized library endpoint, including an empty library', async () => {
  let size = 1;
  const { plex, close } = await fixture((req, res) => {
    assert.equal(req.url, '/library/sections');
    assert.equal(req.headers['x-plex-token'], 'fixture-access-token');
    assert.equal(req.headers.accept, 'application/json');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ MediaContainer: { size, Directory: size ? [{ key: '1', type: 'movie' }] : [] } }));
  });
  try {
    assert.equal(await plex.canAccess(), true);
    size = 0;
    assert.equal(await plex.canAccess(), true, 'No existing movies are required to grant library access.');
  } finally { await close(); }
});

test('Plex access fails closed for rejected, malformed, or unrelated responses', async () => {
  let status = 403;
  let body = JSON.stringify({ MediaContainer: { size: 1 } });
  const { plex, close } = await fixture((req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  try {
    for (const rejected of [401, 403, 404, 500]) {
      status = rejected;
      assert.equal(await plex.canAccess(), false, `HTTP ${rejected} cannot establish Plex access.`);
    }
    status = 200;
    for (const invalid of ['', '{', '{}', 'null', '{"authenticated":true}', '{"MediaContainer":null}', '{"MediaContainer":true}', '{"MediaContainer":"Plex"}', '{"MediaContainer":[]}']) {
      body = invalid;
      assert.equal(await plex.canAccess(), false, `Invalid library response ${JSON.stringify(invalid)} cannot establish access.`);
    }
  } finally { await close(); }
});

test('Plex access stops an unresponsive response within its three-second deadline', async () => {
  const { plex, close } = await fixture((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"MediaContainer":');
  });
  try {
    const start = performance.now();
    assert.equal(await plex.canAccess(), false);
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 2900 && elapsed < 4000, `The probe should abort after three seconds, including response-body reads; took ${elapsed.toFixed(0)}ms.`);
  } finally { await close(); }
});

test('Plex access returns false when its server is no longer reachable', async () => {
  const { plex, close } = await fixture((req, res) => res.end('{}'));
  await close();
  assert.equal(await plex.canAccess(), false);
});

test('Plex without a token still starts and grants access only when its server permits the library request', async () => {
  let permitted = false;
  const { plex, close } = await fixture((req, res) => {
    assert.equal(req.headers['x-plex-token'], undefined, 'Missing credentials must be omitted, never sent as undefined.');
    res.writeHead(permitted ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(permitted ? { MediaContainer: { size: 0 } } : { error: 'Unauthorized' }));
  });
  const withoutToken = new Plex({ url: plex.url });
  try {
    assert.equal(await withoutToken.canAccess(), false);
    permitted = true;
    assert.equal(await withoutToken.canAccess(), true, 'A server permitting tokenless LAN access is usable.');
  } finally { await close(); }
  assert.equal(await withoutToken.canAccess(), false, 'Missing or stopped servers fail closed without crashing startup.');
});
