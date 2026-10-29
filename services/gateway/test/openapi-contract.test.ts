/**
 * Contract checks for the gateway's own routes: real requests against the app createApp() builds
 * (standalone mode, no listen), each response checked against the status and schema that
 * openapi/gateway.yaml documents for it. The vendor routes link the vendor's spec and are covered by
 * openapi-coverage.test.ts only. SAP AI Core is never reached: the model list is a fixture at the
 * modelService seam the model-route tests use, and its token call throws.
 */
process.env.GATEWAY_STANDALONE = 'true';
process.env.UNIFIED_TOKEN_SYSTEM_ENABLED = 'false';

import * as path from 'path';
import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import Ajv2020 from 'ajv/dist/2020';
import { loadOpenApi } from '@libs/test-utils';
import { ConfigLoader } from '../../../libs/config';

const MODELS = {
  object: 'list',
  data: [
    { id: 'gpt-5-mini', object: 'model', created: 1760000000, owned_by: 'openai' },
    { id: 'anthropic--claude-4.5-haiku', object: 'model', created: 1760000000, owned_by: 'anthropic' },
  ],
};

jest.mock('../src/services/modelService', () => {
  const actual: any = jest.requireActual('../src/services/modelService');
  const list = async () => MODELS;
  const byId = async (id: string) => MODELS.data.find((m) => m.id === id) ?? null;
  const api = {
    getModels: list,
    getModelById: byId,
    getModelDetails: byId,
    clearModelsCache: () => undefined,
    getAuthToken: async () => { throw new Error('SAP AI Core is not reachable from the contract tests'); },
  };
  return { ...actual, __esModule: true, ...api, default: { ...actual.default, ...api } };
});

import apiKeyService from '../src/services/apiKeyService';
import { createApp } from '../src/app';

const KEY = 'sk-example-contract-key';
const GATEWAY_DOC = path.resolve(__dirname, '../../../openapi/gateway.yaml');

let doc: Awaited<ReturnType<typeof loadOpenApi>>;
let app: ReturnType<typeof createApp>['app'];
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

beforeAll(async () => {
  doc = await loadOpenApi(GATEWAY_DOC);
  ajv.addSchema({ $id: 'gateway.yaml', components: doc.components });
  app = createApp(new ConfigLoader('gateway').loadConfig()).app;
});

// Per test: the jest config restores spies after each one (restoreMocks).
beforeEach(() => {
  jest.spyOn(apiKeyService, 'validateApiKey').mockImplementation(async (key: string) =>
    (key === KEY ? ({ id: 'key-example', name: 'Example key', active: true } as any) : null));
});

/** The JSON schema the document gives `method path` for `status`; fails when the status is not documented. */
function documentedSchema(p: string, method: string, status: number): object {
  const op = (doc.paths?.[p] as any)?.[method];
  expect(op).toBeDefined();
  let response = op.responses?.[String(status)];
  // A shared response is a $ref into #/components/responses.
  if (response?.$ref) response = (doc.components?.responses as any)?.[response.$ref.split('/').pop()];
  if (!response) throw new Error(`${method.toUpperCase()} ${p} does not document a ${status} response`);
  const schema = response.content?.['application/json']?.schema;
  if (!schema) throw new Error(`${method.toUpperCase()} ${p} ${status} has no application/json schema`);
  // Refs inside the operation point at #/components/...; resolve them against the document.
  return JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"gateway.yaml#/components/'));
}

function expectMatches(p: string, method: string, res: request.Response): void {
  const validate = ajv.compile(documentedSchema(p, method, res.status));
  const ok = validate(res.body);
  expect({ status: res.status, errors: ok ? null : validate.errors }).toEqual({ status: res.status, errors: null });
}

describe('gateway OpenAPI contract', () => {
  it('GET /health answers the documented HealthResponse', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expectMatches('/health', 'get', res);
  });

  it('GET / answers the documented ServiceInfo', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expectMatches('/', 'get', res);
  });

  it('GET /v1/models with a key answers the documented ModelList', async () => {
    const res = await request(app).get('/v1/models').set('Authorization', `Bearer ${KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: any) => m.id)).toEqual(MODELS.data.map((m) => m.id));
    expectMatches('/v1/models', 'get', res);
  });

  it('GET /v1/models/{model_id} answers a Model, and the documented 404 for an id it does not list', async () => {
    const found = await request(app).get('/v1/models/gpt-5-mini').set('x-api-key', KEY);
    expect(found.status).toBe(200);
    expectMatches('/v1/models/{model_id}', 'get', found);
    const unknown = await request(app).get('/v1/models/no-such-model').set('x-api-key', KEY);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.type).toBe('model_not_found_error');
    expectMatches('/v1/models/{model_id}', 'get', unknown);
  });

  it('POST /v1/models/cache/clear answers the documented CacheCleared', async () => {
    const res = await request(app).post('/v1/models/cache/clear').set('x-api-key', KEY);
    expect(res.status).toBe(200);
    expectMatches('/v1/models/cache/clear', 'post', res);
  });

  it('a request without a key to POST /openai/v1/chat/completions answers the documented 401 GatewayError', async () => {
    const res = await request(app).post('/openai/v1/chat/completions').send({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Hello' }] });
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
    expectMatches('/openai/v1/chat/completions', 'post', res);
  });

  it('SAP-RPT refuses a request without a key with the documented 401 in the SAP shape', async () => {
    const res = await request(app).post('/sap/v1/rpt/sap-rpt-1-small/predict').send({ rows: [] });
    expect(res.status).toBe(401);
    expectMatches('/sap/v1/rpt/{model}/predict', 'post', res);
  });

  it('SAP-RPT answers a model it does not serve with the documented 404 in the SAP shape', async () => {
    const res = await request(app).post('/sap/v1/rpt/sap-rpt-unknown/predict').set('x-api-key', KEY).send({ rows: [] });
    expect(res.status).toBe(404);
    expect(res.body.detail[0].type).toBe('model_not_found');
    expectMatches('/sap/v1/rpt/{model}/predict', 'post', res);
  });
});
