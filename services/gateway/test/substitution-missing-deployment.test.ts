/**
 * The shipped substitute_models map Anthropic and Bedrock names to `X--deployed`. On a tenant
 * without that deployment the model is still served through orchestration as `X`, so the request
 * has to go there instead of ending in a 404. A tenant with the deployment keeps its mapping.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

const DATED = 'claude-sonnet-4-5-20250929';
const PLAIN = 'anthropic--claude-4.5-sonnet';
const DEPLOYED = `${PLAIN}--deployed`;

let listed: string[] = [];
let listFails = false;
const detailsAskedFor: string[] = [];
jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModels: () => (listFails ? Promise.reject(new Error('SAP down')) : Promise.resolve({ object: 'list', data: listed.map((id) => ({ id })) })),
    getModelDetails: (id: string) => { detailsAskedFor.push(id); return Promise.resolve(null); },
  },
}));
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getConfig: () => ({}),
    getSubstitutedModel: (_p: string, m: string) => (m === DATED ? DEPLOYED : m),
    getHookConfig: () => undefined,
  },
}));
jest.mock('../src/services/pluginExecutor', () => ({ executeBeforePlugins: () => Promise.resolve({ stop: false }), executeAfterPlugins: (_q: any, _s: any, b: any) => Promise.resolve(b) }));
jest.mock('../src/utils/payloadLogger', () => ({ savePayload: () => {}, isPayloadLoggingEnabled: () => false }));
jest.mock('../src/utils/modelEntitlement', () => ({ enforceEntitlement: () => true }));
jest.mock('../src/utils/imageTokenCapture', () => ({ captureImageTokensAsync: jest.fn() }));
jest.mock('../src/services/sapAIService', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/anthropicService', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/awsBedrockService', () => ({ __esModule: true, default: {} }));

import { withoutMissingDeployment } from '../src/utils/substitutionFallback';
import { handleMessages } from '../src/controllers/anthropicController';
import { handleBedrockRequest } from '../src/controllers/awsBedrockController';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), { statusCode: 200, body: undefined, headers: {}, headersSent: false });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.setHeader = () => {};
  r.set = () => r;
  r.json = (b: any) => { r.body = b; r.headersSent = true; return r; };
  r.write = () => true;
  r.end = () => {};
  return r;
}

beforeEach(() => {
  listed = [PLAIN];
  listFails = false;
  detailsAskedFor.length = 0;
});

describe('withoutMissingDeployment', () => {
  it('names the plain model when the mapped deployment does not exist', async () => {
    expect(await withoutMissingDeployment('anthropic', DATED)).toBe(PLAIN);
  });

  it('keeps the client name when the deployment exists', async () => {
    listed = [PLAIN, DEPLOYED];
    expect(await withoutMissingDeployment('anthropic', DATED)).toBe(DATED);
  });

  it('keeps the client name when neither exists, so the 404 names what the client asked for', async () => {
    listed = [];
    expect(await withoutMissingDeployment('anthropic', DATED)).toBe(DATED);
  });

  it('leaves a name without a mapping alone', async () => {
    expect(await withoutMissingDeployment('anthropic', PLAIN)).toBe(PLAIN);
  });

  it('keeps the client name when the model list cannot be read', async () => {
    listFails = true;
    expect(await withoutMissingDeployment('anthropic', DATED)).toBe(DATED);
  });
});

describe('routes', () => {
  it('/anthropic looks up the plain model and carries it on the request', async () => {
    const req: any = Object.assign(new EventEmitter(), {
      body: { model: DATED, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'anthropic-version': '2023-06-01' }, query: {},
    });
    await handleMessages(req, mockRes(), () => {});
    expect(detailsAskedFor).toEqual([PLAIN]);
    expect(req.body.model).toBe(PLAIN);
  });

  it('/aws-bedrock looks up the plain model', async () => {
    const req: any = Object.assign(new EventEmitter(), {
      params: { modelId: DATED, subpath: 'invoke' },
      body: { messages: [{ role: 'user', content: 'hi' }] }, headers: {}, query: {},
    });
    await handleBedrockRequest(req, mockRes(), () => {});
    expect(detailsAskedFor).toEqual([PLAIN]);
    expect(req.params.modelId).toBe(PLAIN);
  });
});
