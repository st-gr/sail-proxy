/**
 * responsesController stashes the resolved Responses route ('native' vs 'orchestration')
 * on the request BEFORE running before-plugins, so responsesImagePlugin can normalise
 * remote `input_image` urls only for the orchestration bridge — the deployed (native)
 * route already accepts them today and must not be touched by that plugin.
 *
 * Both branches return `{ stop: true }` from the mocked before-plugin so the controller
 * returns immediately, right after the stash — no need to mock the rest of either
 * dispatch path (axios / sapAIService) just to observe this one assignment.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (m: string) => Promise.resolve(
      m === 'gpt-5.3-codex--deployed'
        ? { id: m, model: 'gpt-5.3-codex', owned_by: 'OpenAI', deploymentUrl: 'http://mock-sap/deployments/abc' }
        : m === 'anthropic--claude-4.8-opus'
          ? { id: m, model: m, owned_by: 'Anthropic' }   // no deploymentUrl -> orchestration
          : null
    ),
    getAuthToken: () => Promise.resolve('tok'),
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSupportsResponsesApi: () => undefined,
    getUnsupportedParams: () => [],
    getParamRenames: () => ({}),
    getTimeout: () => 1000,
    getHookConfig: () => ([{ request: { callback: { id: 'somePlugin' } } }]),
    isPseudonymizationForced: () => false,
    getConfig: () => ({}),
  },
}));

const capturedReqs: any[] = [];
jest.mock('../src/services/pluginExecutor', () => ({
  executeBeforePlugins: (req: any) => { capturedReqs.push(req); return Promise.resolve({ stop: true }); },
  executeAfterPlugins: (_req: any, _res: any, body: any) => Promise.resolve(body),
}));

import { handleResponses } from '../src/controllers/responsesController';

function mockRes() {
  const r: any = Object.assign(new EventEmitter(), { statusCode: 200, body: undefined });
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.setHeader = () => {};
  return r;
}

function mockReq(body: any) {
  const r: any = new EventEmitter();
  r.body = body;
  r.headers = {};
  return r;
}

beforeEach(() => { capturedReqs.length = 0; });

describe('responsesController — __responsesRoute stash', () => {
  it('stashes "native" for a model served by its own deployment', async () => {
    await handleResponses(mockReq({ model: 'gpt-5.3-codex--deployed', input: 'hi' }), mockRes(), () => {});

    expect(capturedReqs).toHaveLength(1);
    expect(capturedReqs[0].__responsesRoute).toBe('native');
  });

  it('stashes "orchestration" for an undeployed catalogue model routed through the bridge', async () => {
    await handleResponses(mockReq({ model: 'anthropic--claude-4.8-opus', input: 'hi' }), mockRes(), () => {});

    expect(capturedReqs).toHaveLength(1);
    expect(capturedReqs[0].__responsesRoute).toBe('orchestration');
  });
});
