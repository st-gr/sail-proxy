/**
 * The Ollama service's OpenAPI document (openapi/ollama.yaml) against the routes the app mounts,
 * and a contract check of the answers that need no gateway: the app is listened on 127.0.0.1 with an
 * ephemeral port, and nothing here reaches the gateway.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Ajv2020 = require('ajv/dist/2020');
const { compareRoutes, documentedRoutes, listExpressRoutes, loadOpenApi } = require('@libs/test-utils');

const OPENAPI_DIR = path.resolve(__dirname, '../../../openapi');
const OLLAMA_DOC = path.join(OPENAPI_DIR, 'ollama.yaml');
const internal = JSON.parse(fs.readFileSync(path.join(OPENAPI_DIR, 'internal-routes.json'), 'utf8'));

const app = require('../index');
const keyOf = (k) => `${k.method} ${k.path}`;

describe('Ollama OpenAPI document', () => {
  let doc;
  let server;
  let http;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

  beforeAll(async () => {
    doc = await loadOpenApi(OLLAMA_DOC);
    ajv.addSchema({ $id: 'ollama.yaml', components: doc.components });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    http = axios.create({
      baseURL: `http://127.0.0.1:${server.address().port}`,
      validateStatus: () => true
    });
  });

  afterAll(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

  // The schema the document gives `method path` for the response's status; fails when it is not documented.
  const expectDocumented = (method, urlPath, response) => {
    let documented = doc.paths[urlPath][method].responses[String(response.status)];
    // A shared response is a $ref into #/components/responses.
    if (documented && documented.$ref) documented = doc.components.responses[documented.$ref.split('/').pop()];
    if (!documented) throw new Error(`${method.toUpperCase()} ${urlPath} does not document a ${response.status} response`);
    const schema = documented.content && documented.content['application/json'] && documented.content['application/json'].schema;
    if (!schema) throw new Error(`${method.toUpperCase()} ${urlPath} ${response.status} has no application/json schema`);
    // Refs inside the operation point at #/components/...; resolve them against the document.
    const validate = ajv.compile(JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"ollama.yaml#/components/')));
    const valid = validate(response.data);
    expect({ status: response.status, errors: valid ? null : validate.errors }).toEqual({ status: response.status, errors: null });
  };

  it('is a valid OpenAPI 3.1 document', () => {
    expect(doc.openapi).toBe('3.1.0');
  });

  it('every mounted route is documented or listed as internal', () => {
    const { undocumented, stale } = compareRoutes(listExpressRoutes(app), documentedRoutes(doc), internal.ollama);
    // Lists, not counts, so a failure names the routes to add or remove.
    expect({ undocumented: undocumented.map(keyOf), stale: stale.map(keyOf) }).toEqual({ undocumented: [], stale: [] });
  });

  it('GET /health answers 200 as documented', async () => {
    const response = await http.get('/health');
    expect(response.status).toBe(200);
    expectDocumented('get', '/health', response);
  });

  it('GET / answers 200 as documented', async () => {
    const response = await http.get('/');
    expect(response.status).toBe(200);
    expectDocumented('get', '/', response);
  });

  it('GET /api/version and GET /api/ps answer 200 as documented', async () => {
    for (const urlPath of ['/api/version', '/api/ps']) {
      const response = await http.get(urlPath);
      expect(response.status).toBe(200);
      expectDocumented('get', urlPath, response);
    }
  });

  it('POST /api/show without a model answers 400 as documented', async () => {
    const response = await http.post('/api/show', {});
    expect(response.status).toBe(400);
    expectDocumented('post', '/api/show', response);
  });

  it('model management answers 501 as documented', async () => {
    const response = await http.post('/api/pull', { model: 'example' });
    expect(response.status).toBe(501);
    expectDocumented('post', '/api/pull', response);
    const deleted = await http.delete('/api/delete', { data: { model: 'example' } });
    expect(deleted.status).toBe(501);
    expectDocumented('delete', '/api/delete', deleted);
  });

  it('HEAD /api/blobs/{digest} answers 404 and an unknown path answers the documented 404', async () => {
    expect((await http.head('/api/blobs/sha256:example')).status).toBe(404);
    const response = await http.get('/api/embeddings');
    expect(response.status).toBe(404);
    expect(response.data.error.code).toBe('endpoint_not_found');
  });
});
