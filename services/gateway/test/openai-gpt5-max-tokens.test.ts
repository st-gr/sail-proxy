/**
 * gpt-5 orchestration max_tokens (#4)
 *
 * Live spike (2026-08-29, dev gateway, gpt-5-mini via orchestration) proved
 * SAP orchestration honors a raw `max_tokens` cap for gpt-5 models — sending
 * `max_tokens: 8` yielded HTTP 200, completion_tokens: 8, finish_reason:
 * "length". The prior `delete modelParams.max_tokens` was silently dropping
 * a cap SAP would have respected. Fix: rename to `max_completion_tokens`
 * (mirroring the deployed path) instead of deleting.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

jest.mock('../src/services/modelService', () => ({
  __esModule: true,
  default: {
    getModelDetails: (model: string) => Promise.resolve({ id: model, owned_by: 'openai' }),
    modelSupportsStreaming: () => true,
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    shouldEmulateStreaming: () => false,
    getSAPAICoreConfig: () => ({ url: 'http://mock-sap', resourceGroup: 'default' }),
    getUnsupportedParams: () => [],
  },
}));

jest.mock('../src/utils/modelUtils', () => ({
  mapModelParameters: (p: Record<string, any>) => ({ ...p }),
  getDefaultParameters: () => ({}),
}));

import { transformRequestToSAPFormat } from '../src/controllers/openaiController';

describe('gpt-5 orchestration max_tokens (#4)', () => {
  it('renames max_tokens -> max_completion_tokens for gpt-5 (does not drop the cap)', async () => {
    const payload: any = await transformRequestToSAPFormat({
      model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    } as any);
    const params = payload.config.modules.prompt_templating.model.params;
    expect(params.max_tokens).toBeUndefined();
    expect(params.max_completion_tokens).toBe(8);
  });
});
