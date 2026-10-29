import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { renderEndpoints, replaceGenerated, START, END } from './gen-endpoints.mjs';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');

const fixture = {
  openapi: '3.1.0',
  tags: [{ name: 'Alpha', description: 'Alpha routes need the alpha store.' }, { name: 'Beta' }],
  paths: {
    '/b/health': {
      get: { tags: ['Beta'], 'x-sail-upstream': 'The gateway', 'x-sail-credential': 'None' }
    },
    '/a/items': {
      'x-sail-aliases': ['/a/api/items'],
      parameters: [{ name: 'x', in: 'query' }],
      post: { tags: ['Alpha'], 'x-sail-upstream': 'Item store | upload', 'x-sail-credential': 'Gateway API key' },
      get: { tags: ['Alpha'], 'x-sail-upstream': 'Item store | upload', 'x-sail-credential': 'Gateway API key' },
      delete: { tags: ['Alpha'], 'x-sail-upstream': 'Item store, removal', 'x-sail-credential': 'Gateway API key' }
    },
    '/a/models': {
      get: { tags: ['Alpha'], 'x-sail-upstream': 'Model list', 'x-sail-credential': 'Gateway API key or SigV4' }
    }
  }
};

const internal = {
  gateway: [
    { method: 'get', path: '/api/admin/keys', upstream: 'Key store', credential: 'None', section: 'Administration', reason: 'r' },
    { method: 'post', path: '/api/admin/keys', upstream: 'Key store', credential: 'None', section: 'Administration', reason: 'r' },
    { method: 'get', path: '/docs', upstream: 'The gateway itself', credential: 'None', section: 'Local API page', reason: 'r' }
  ],
  adminRest: [{ method: 'get', path: '/not-rendered', reason: 'r' }],
  ollama: []
};

const expected = `## Alpha

| Method | Path | Upstream |
|---|---|---|
| \`POST\`, \`GET\` | \`/a/items\`<br>also \`/a/api/items\` | Item store \\| upload |
| \`DELETE\` | \`/a/items\`<br>also \`/a/api/items\` | Item store, removal |
| \`GET\` | \`/a/models\` | Model list |

Alpha routes need the alpha store.

## Beta

| Method | Path | Upstream |
|---|---|---|
| \`GET\` | \`/b/health\` | The gateway |

## Administration

These routes are for operating the gateway, not for clients. [API authentication](/reference/authentication#administration-endpoints) says where each of them is served and who may call it.

| Method | Path | Upstream |
|---|---|---|
| \`GET\`, \`POST\` | \`/api/admin/keys\` | Key store |

## Credentials per route

Header names, precedence and the SigV4 rules are on [API authentication](/reference/authentication); the administration routes have [their own rules](/reference/authentication#administration-endpoints).

- **Gateway API key:** \`POST /a/items\`, \`GET /a/items\`, \`DELETE /a/items\`
- **Gateway API key or SigV4:** \`GET /a/models\`
- **None:** \`GET /b/health\`
`;

test('renderEndpoints renders one section per tag in tag order, then Administration and the credentials', () => {
  assert.equal(renderEndpoints(fixture, internal), expected);
});

test('renderEndpoints fails on an operation without x-sail-upstream or with an unknown tag', () => {
  const noUpstream = { tags: [{ name: 'Alpha' }], paths: { '/x': { get: { tags: ['Alpha'], 'x-sail-credential': 'None' } } } };
  assert.throws(() => renderEndpoints(noUpstream, { gateway: [] }), /get \/x.*x-sail-upstream/);
  const unknownTag = { tags: [{ name: 'Alpha' }], paths: { '/x': { get: { tags: ['Gamma'], 'x-sail-upstream': 'u', 'x-sail-credential': 'None' } } } };
  assert.throws(() => renderEndpoints(unknownTag, { gateway: [] }), /Gamma/);
});

test('replaceGenerated swaps only the text between the markers', () => {
  const page = `intro\n\n${START}\nold\n${END}\n\nafter\n`;
  assert.equal(replaceGenerated(page, 'new\n'), `intro\n\n${START}\n\nnew\n\n${END}\n\nafter\n`);
  assert.throws(() => replaceGenerated('no markers', 'x'), /markers/);
});

test('the committed api-endpoints.md equals the generated one', () => {
  const doc = parse(readFileSync(join(docs, '..', 'openapi', 'gateway.yaml'), 'utf8'));
  const routes = JSON.parse(readFileSync(join(docs, '..', 'openapi', 'internal-routes.json'), 'utf8'));
  const page = readFileSync(join(docs, 'reference', 'api-endpoints.md'), 'utf8');
  assert.equal(page, replaceGenerated(page, renderEndpoints(doc, routes)),
    'docs/reference/api-endpoints.md is stale: run node docs/scripts/gen-endpoints.mjs');
});
