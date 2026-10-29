import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClient } from './odata.mjs';

test('sends identity headers and JSON bodies, parses JSON answers', async () => {
  let last;
  const srv = createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      last = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: '1', key: 'sk-demo' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = createClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, identity: { name: 'M', email: 'm@example.com', role: 'admin' } });
  const r = await c.action('createApiKey', { name: 'n', email: 'm@example.com' });
  assert.equal(r.status, 201); assert.equal(r.json.id, '1');
  assert.equal(last.method, 'POST'); assert.equal(last.url, '/odata/v4/admin/createApiKey');
  assert.equal(last.headers['x-auth-request-email'], 'm@example.com');
  assert.equal(last.headers['x-auth-request-groups'], undefined);
  assert.equal(JSON.parse(last.body).name, 'n');
  const b = await c.boundAction("ApiKeys(ID=abc,IsActiveEntity=true)", 'rotateApiKey', {});
  assert.equal(last.url, '/odata/v4/admin/ApiKeys(ID=abc,IsActiveEntity=true)/AdminService.rotateApiKey');
  assert.equal(b.status, 201);
  srv.close();
});
