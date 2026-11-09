/**
 * Regression tests for B13: the stand-in response object that
 * handleOpenAIChat passes into ollamaAdapter.handleStreamingChat has no
 * status() and a writableEnded fixed at false. A mid-stream upstream error
 * then throws inside an event listener, and a second final chunk can be
 * written after [DONE].
 */

const { EventEmitter } = require('events');

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
      // Real Express flushes headers on the first write.
      res.headersSent = true;
    }),
    status: jest.fn(function (code) {
      // Real Express res.status() only sets the status code - it does not
      // flush headers. headersSent flips true only once write/end/json is
      // actually called.
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

function makeReq(overrides = {}) {
  return {
    body: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      ...overrides
    }
  };
}

describe('handleOpenAIChat streaming stand-in (B13)', () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    // The handler logs a request-received line, and the adapter logs the
    // upstream error it recovers from — both expected here, not noise to
    // let leak into the suite's output.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('does not throw when the upstream errors mid-stream, and ends the response', async () => {
    const upstream = new EventEmitter();
    mockShared.callMainProxyStreaming.mockResolvedValue({ data: upstream });

    const req = makeReq();
    const res = makeExpressRes();

    await ollamaController.handleOpenAIChat(req, res);

    expect(() => {
      upstream.emit('data', 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      upstream.emit('error', new Error('boom'));
    }).not.toThrow();

    expect(res.end).toHaveBeenCalled();
    // The adapter's error handler logs the recovered error; that is the
    // expected signal here, not a failure to suppress.
    expect(errorSpy).toHaveBeenCalledWith('Streaming error:', expect.stringContaining('boom'));
  });

  it('writes exactly one final chunk when [DONE] is followed by an upstream end event', async () => {
    const upstream = new EventEmitter();
    mockShared.callMainProxyStreaming.mockResolvedValue({ data: upstream });

    const req = makeReq();
    const res = makeExpressRes();

    await ollamaController.handleOpenAIChat(req, res);

    upstream.emit('data', 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    upstream.emit('end');

    const doneWrites = res.write.mock.calls.filter(([chunk]) => chunk.includes('[DONE]'));
    expect(doneWrites).toHaveLength(1);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('answers a pre-stream failure (e.g. an unknown model) as JSON, not an SSE frame', async () => {
    // The gateway rejects before any chunk is streamed - the adapter's own
    // outer catch runs, calling res.status(500).json({...}) on the stand-in
    // with nothing yet flushed to the client.
    mockShared.callMainProxyStreaming.mockRejectedValue(new Error('unknown model'));

    const req = makeReq();
    const res = makeExpressRes();

    await ollamaController.handleOpenAIChat(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'unknown model',
        type: 'api_error',
        code: 'streaming_error'
      }
    });
    // Not the SSE error frame the mid-stream path uses.
    expect(res.write).not.toHaveBeenCalled();
  });
});
