import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startProxy, identityHeaders } from './proxy.js';

test('identityHeaders maps an identity to the oauth2-proxy identity headers, without groups', () => {
  const h = identityHeaders({ name: 'Mara Lindqvist', email: 'mara.lindqvist@example.com', role: 'admin' });
  assert.deepEqual(h, {
    'x-auth-request-user': 'mara.lindqvist@example.com',
    'x-auth-request-email': 'mara.lindqvist@example.com',
    'x-auth-request-preferred-username': 'Mara Lindqvist',
    'x-forwarded-prefix': '/admin'
  });
});

test('strips /admin, injects the headers and rewrites a relative Location', async () => {
  const seen = [];
  const target = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/app/shell/' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;
  const proxy = await startProxy({ port: 0, targetPort, identity: { name: 'U', email: 'u@example.com', role: 'user' } });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const r1 = await fetch(`${base}/admin/odata/v4/admin/`, { headers: { 'x-auth-request-groups': 'spoofed' } });
  assert.equal(r1.status, 200);
  assert.equal(seen[0].url, '/odata/v4/admin/');
  assert.equal(seen[0].headers['x-auth-request-email'], 'u@example.com');
  assert.equal(seen[0].headers['x-auth-request-groups'], undefined);
  const r2 = await fetch(`${base}/admin/redirect`, { redirect: 'manual' });
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), '/admin/app/shell/');
  const r3 = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(r3.headers.get('location'), '/admin/app/shell/');
  proxy.close(); target.close();
});
