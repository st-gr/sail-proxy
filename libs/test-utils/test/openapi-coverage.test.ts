import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenAPIV3_1 } from 'openapi-types';
import { compareRoutes, documentedRoutes, loadOpenApi } from '../src/openapi-coverage';

describe('documentedRoutes', () => {
  it('lists every operation and every alias path', () => {
    const doc = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/v1/models': {
          get: { responses: { 200: { description: 'ok' } } },
          post: { responses: { 200: { description: 'ok' } } },
          parameters: [],
          'x-sail-aliases': ['/openai/v1/models']
        }
      }
    } as unknown as OpenAPIV3_1.Document;
    expect(documentedRoutes(doc)).toEqual([
      { method: 'get', path: '/v1/models' },
      { method: 'post', path: '/v1/models' },
      { method: 'get', path: '/openai/v1/models' },
      { method: 'post', path: '/openai/v1/models' }
    ]);
  });
});

describe('compareRoutes', () => {
  it('reports undocumented and stale routes; internal routes are neither', () => {
    const actual = [
      { method: 'get', path: '/a' },
      { method: 'get', path: '/b' },
      { method: 'get', path: '/c' }
    ];
    const documented = [
      { method: 'get', path: '/a' },
      { method: 'get', path: '/gone' }
    ];
    const internal = [{ method: 'get', path: '/c' }, { method: 'get', path: '/old' }];
    expect(compareRoutes(actual, documented, internal)).toEqual({
      undocumented: [{ method: 'get', path: '/b' }],
      stale: [{ method: 'get', path: '/gone' }, { method: 'get', path: '/old' }]
    });
  });
});

describe('loadOpenApi', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads valid YAML and JSON', async () => {
    const y = path.join(dir, 'ok.yaml');
    fs.writeFileSync(y, 'openapi: 3.1.0\ninfo:\n  title: t\n  version: "1"\npaths: {}\n');
    expect((await loadOpenApi(y)).info.title).toBe('t');
    const j = path.join(dir, 'ok.json');
    fs.writeFileSync(j, JSON.stringify({ openapi: '3.1.0', info: { title: 'j', version: '1' }, paths: {} }));
    expect((await loadOpenApi(j)).info.title).toBe('j');
  });

  it('rejects a document without info, naming it', async () => {
    const f = path.join(dir, 'bad.yaml');
    fs.writeFileSync(f, 'openapi: 3.1.0\npaths: {}\n');
    await expect(loadOpenApi(f)).rejects.toThrow(/info/);
  });
});
