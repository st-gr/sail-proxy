import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncOpenapi, copySwaggerCss } from './sync-openapi.mjs';
import { API_DOCUMENTS, SWAGGER_CSS, documentUrls } from '../.vitepress/theme/components/apiDocuments.mjs';

const FILES = ['gateway.yaml', 'admin-odata.json', 'admin-rest.yaml', 'ollama.yaml'];

test('copies the four OpenAPI documents and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'openapi-'));
  const src = join(root, 'openapi');
  mkdirSync(src);
  for (const f of [...FILES, 'internal-routes.json', 'README.md']) writeFileSync(join(src, f), `content of ${f}`);
  const dest = join(root, 'public', 'openapi');
  assert.deepEqual(syncOpenapi(src, dest).sort(), [...FILES].sort());
  assert.deepEqual(readdirSync(dest).sort(), [...FILES].sort());
  for (const f of FILES) assert.equal(readFileSync(join(dest, f), 'utf8'), `content of ${f}`);
});

test('fails with a clear message when a document is missing', () => {
  const src = mkdtempSync(join(tmpdir(), 'openapi-'));
  writeFileSync(join(src, 'gateway.yaml'), 'x');
  assert.throws(() => syncOpenapi(src, join(src, 'out')), /admin-odata\.json/);
});

test('the page offers the four documents, each under the site base', () => {
  assert.deepEqual(API_DOCUMENTS.map((d) => d.file), FILES);
  const withBase = (p) => `/sail-proxy${p}`;
  assert.deepEqual(documentUrls(withBase), [
    { url: '/sail-proxy/openapi/gateway.yaml', name: 'Gateway' },
    { url: '/sail-proxy/openapi/admin-odata.json', name: 'Admin OData' },
    { url: '/sail-proxy/openapi/admin-rest.yaml', name: 'Admin REST' },
    { url: '/sail-proxy/openapi/ollama.yaml', name: 'Ollama' }
  ]);
});

test("copies Swagger UI's stylesheet to the path the page links", () => {
  const root = mkdtempSync(join(tmpdir(), 'swagger-'));
  writeFileSync(join(root, 'swagger-ui.css'), '.swagger-ui{}');
  const dest = join(root, 'public', 'openapi');
  assert.equal(copySwaggerCss(root, dest), 'swagger-ui.css');
  assert.equal(SWAGGER_CSS, '/openapi/swagger-ui.css');
  assert.equal(readFileSync(join(dest, 'swagger-ui.css'), 'utf8'), '.swagger-ui{}');
  assert.throws(() => copySwaggerCss('/nonexistent/pkg', dest), /swagger-ui-dist/);
});
