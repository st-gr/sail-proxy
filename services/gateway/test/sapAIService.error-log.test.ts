/**
 * SAP AI Core's orchestration error body repeats the fully templated prompt
 * (`error.intermediate_results.templating`). The gateway logged that body at ERROR
 * level, so a refused request put its prompt into the gateway's console output.
 * The log line keeps SAP's identifiers and message only (upstreamErrorForLog);
 * the caller still gets the body it got before.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const logged: any[][] = [];
const record = (...args: any[]) => { logged.push(args); };

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: record, warn: record, info: record, debug: jest.fn(), trace: jest.fn() }),
  createSafePreview: (v: any) => JSON.stringify(v).slice(0, 200),
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSAPAICoreConfig: () => ({ url: 'https://mock-sap.example.com', resourceGroup: 'default' }),
    getDeploymentId: () => Promise.resolve('mock-deployment-id'),
    getAccessToken: () => Promise.resolve('mock-token'),
    getTimeout: () => 30000,
  },
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: { markModelAsNonStreaming: jest.fn() },
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...args: any[]) => (mockAxiosPost as any)(...args), isCancel: () => false },
}));

import sapAIService from '../src/services/sapAIService';
import { upstreamErrorForLog } from '../src/utils/upstreamErrorEnvelope';

const PROMPT = 'Jane Roe asked canary-0f3a9c21';

/** The shape SAP's orchestration answers a refused model with (container check, 2026-11-14). */
function sapRefusal(): any {
  const err: any = new Error('Request failed with status code 400');
  err.response = {
    status: 400,
    data: {
      error: {
        request_id: 'req-1',
        code: 400,
        message: 'Model name no-such-model is not supported.',
        location: 'Request Body',
        intermediate_results: { templating: [{ role: 'user', content: PROMPT }] },
      },
    },
  };
  return err;
}

const payload: any = {
  config: { modules: { prompt_templating: { prompt: { template: [{ role: 'user', content: 'hi' }] }, model: { name: 'no-such-model', version: 'latest', params: {} } } } },
  placeholder_values: {},
  messages_history: [],
};

describe('SAP error bodies in the gateway log', () => {
  beforeEach(() => { logged.length = 0; mockAxiosPost.mockReset(); });

  const calls: Array<[string, () => Promise<any>]> = [
    ['completeChat', () => sapAIService.completeChat(payload)],
    ['callSAPAIOrchestration', () => sapAIService.callSAPAIOrchestration(payload)],
    ['createEmbedding', () => sapAIService.createEmbedding({ input: 'x' }, 'text-embedding-3-small')],
  ];

  it.each(calls)('%s logs SAP\'s message and identifiers, not the prompt SAP repeats', async (_name, call) => {
    mockAxiosPost.mockRejectedValueOnce(sapRefusal() as never);
    await expect(call()).rejects.toBeDefined();
    const text = JSON.stringify(logged);
    expect(text).not.toContain('canary-0f3a9c21');
    expect(text).not.toContain('intermediate_results');
    expect(text).toContain('Model name no-such-model is not supported.');
    expect(text).toContain('req-1');
  });

  it('completeChat still hands the caller SAP\'s body unchanged', async () => {
    mockAxiosPost.mockRejectedValueOnce(sapRefusal() as never);
    const thrown: any = await sapAIService.completeChat(payload).catch((e) => e);
    expect(thrown.details.error.message).toBe('Model name no-such-model is not supported.');
  });
});

describe('upstreamErrorForLog', () => {
  it('keeps the label of SAP\'s flat shape and drops everything not allow-listed', () => {
    const flat = { error: 'BadRequest', message: 'rejected', intermediate_results: { templating: [{ content: PROMPT }] } };
    expect(upstreamErrorForLog(flat)).toEqual({ error: 'BadRequest', message: 'rejected' });
  });

  it('caps a plain-text body and passes nothing else through', () => {
    expect(upstreamErrorForLog('x'.repeat(3000))).toHaveLength(2001);
    expect(upstreamErrorForLog(undefined)).toBeUndefined();
  });
});
