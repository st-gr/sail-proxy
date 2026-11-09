/**
 * Real Ollama answers POST /api/generate with an empty prompt as a
 * model-load request: an empty generation with done_reason "load". The
 * facade must not forward an empty message to the model (Gemini rejects it).
 */

jest.mock('../../services/shared', () => ({
  callMainProxy: jest.fn(),
  callMainProxyStreaming: jest.fn()
}));

const mockShared = require('../../services/shared');
const ollamaController = require('../../controllers/ollamaController');

function makeExpressRes() {
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader: jest.fn(),
    write: jest.fn(function () {
      res.headersSent = true;
    }),
    status: jest.fn(function (code) {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn(function () {
      res.headersSent = true;
      res.writableEnded = true;
    })
  };
  res.end = jest.fn(function () {
    res.headersSent = true;
    res.writableEnded = true;
  });
  return res;
}

const MODEL = 'gemini-3.5-flash-lite';

function expectLoadShape(body) {
  expect(body).toMatchObject({
    model: MODEL,
    response: '',
    done: true,
    done_reason: 'load'
  });
  expect(Number.isNaN(Date.parse(body.created_at))).toBe(false);
}

describe('handleGenerate with an empty prompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers a non-streaming empty prompt with the load response', async () => {
    const res = makeExpressRes();
    await ollamaController.handleGenerate({ body: { model: MODEL, prompt: '', stream: false } }, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    expectLoadShape(res.json.mock.calls[0][0]);
    expect(mockShared.callMainProxy).not.toHaveBeenCalled();
    expect(mockShared.callMainProxyStreaming).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only prompt the same way', async () => {
    const res = makeExpressRes();
    await ollamaController.handleGenerate({ body: { model: MODEL, prompt: '   ', stream: false } }, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    expectLoadShape(res.json.mock.calls[0][0]);
    expect(mockShared.callMainProxy).not.toHaveBeenCalled();
    expect(mockShared.callMainProxyStreaming).not.toHaveBeenCalled();
  });

  it('answers a streaming empty prompt with one JSON line', async () => {
    const res = makeExpressRes();
    await ollamaController.handleGenerate({ body: { model: MODEL, prompt: '' } }, res);

    expect(res.write).toHaveBeenCalledTimes(1);
    const line = res.write.mock.calls[0][0];
    expect(line.endsWith('\n')).toBe(true);
    expectLoadShape(JSON.parse(line));
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(mockShared.callMainProxy).not.toHaveBeenCalled();
    expect(mockShared.callMainProxyStreaming).not.toHaveBeenCalled();
  });

  it('still sends a real prompt to the adapter', async () => {
    mockShared.callMainProxy.mockResolvedValue({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: {}
    });
    const res = makeExpressRes();
    await ollamaController.handleGenerate({ body: { model: MODEL, prompt: 'Hi', stream: false } }, res);

    expect(mockShared.callMainProxy).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalled();
  });
});
