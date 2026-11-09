import { describe, it, expect, jest } from '@jest/globals';
import { validateChatRequest } from '../src/controllers/openaiRequestValidation';

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

describe('validateChatRequest (#2)', () => {
  const ok = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] };
  it('accepts a well-formed request', () => {
    expect(validateChatRequest(ok)).toBeNull();
  });
  it('rejects a missing model with a 400-shaped invalid_request_error', () => {
    const e = validateChatRequest({ messages: ok.messages });
    expect(e?.error.type).toBe('invalid_request_error');
    expect(e?.error.param).toBe('model');
  });
  it('rejects a blank model', () => {
    expect(validateChatRequest({ model: '   ', messages: ok.messages })?.error.param).toBe('model');
  });
  it('rejects missing messages', () => {
    expect(validateChatRequest({ model: 'gpt-4' })?.error.param).toBe('messages');
  });
  it('rejects an empty messages array', () => {
    expect(validateChatRequest({ model: 'gpt-4', messages: [] })?.error.param).toBe('messages');
  });
  it('rejects a non-array messages', () => {
    expect(validateChatRequest({ model: 'gpt-4', messages: 'nope' })?.error.param).toBe('messages');
  });
});

describe('handleChatCompletion (#2) — strict 400 on invalid request', () => {
  it('returns 400 with an invalid_request_error for a missing model', async () => {
    const { handleChatCompletion } = await import('../src/controllers/openaiController');

    const req: any = { body: { messages: [{ role: 'user', content: 'hi' }] } };
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res: any = { status, json };
    const next = jest.fn();

    await handleChatCompletion(req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ param: 'model' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });
});
