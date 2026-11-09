/**
 * Regression tests for B12: the Ollama adapter's stream parsers split each
 * network chunk on '\n' independently, with no carried remainder. An SSE
 * event whose bytes straddle two TCP chunks is silently lost.
 */

const { EventEmitter } = require('events');

jest.mock('../../services/shared', () => ({
  callMainProxy: jest.fn(),
  callMainProxyStreaming: jest.fn()
}));

const mockShared = require('../../services/shared');
const ollamaAdapter = require('../../services/ollamaAdapter');

function makeRes() {
  return {
    writableEnded: false,
    write: jest.fn(),
    end: jest.fn(function () { this.writableEnded = true; }),
    status: jest.fn(function () { return this; })
  };
}

describe('Ollama adapter stream line-splitting (B12)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('handleStreamingChat reassembles a data: event split across two TCP chunks', async () => {
    const upstream = new EventEmitter();
    mockShared.callMainProxyStreaming.mockResolvedValue({ data: upstream });

    const res = makeRes();
    const request = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true };

    await ollamaAdapter.handleStreamingChat(request, res);

    // The event is split mid-JSON across two chunks, as a TCP segment boundary would do.
    upstream.emit('data', 'data: {"choices":[{"delta":{"content":"Hel');
    upstream.emit('data', 'lo world"}}]}\n\ndata: [DONE]\n\n');
    upstream.emit('end');

    const written = res.write.mock.calls.map(([line]) => JSON.parse(line));
    const contentLines = written.filter((line) => line.message && line.message.content);

    expect(contentLines).toHaveLength(1);
    expect(contentLines[0].message.content).toBe('Hello world');
  });

  it('handleStreamingGenerate reassembles a data: event split across two TCP chunks', async () => {
    const upstream = new EventEmitter();
    mockShared.callMainProxyStreaming.mockResolvedValue({ data: upstream });

    const res = makeRes();
    const request = { model: 'test-model', prompt: 'hi', stream: true };

    await ollamaAdapter.handleStreamingGenerate(request, res);

    upstream.emit('data', 'data: {"choices":[{"delta":{"content":"Hel');
    upstream.emit('data', 'lo world"}}]}\n\ndata: [DONE]\n\n');
    upstream.emit('end');

    const written = res.write.mock.calls.map(([line]) => JSON.parse(line));
    const contentLines = written.filter((line) => line.response);

    expect(contentLines).toHaveLength(1);
    expect(contentLines[0].response).toBe('Hello world');
  });

  it('flushes a final complete line that never gets a trailing newline before stream end', async () => {
    const upstream = new EventEmitter();
    mockShared.callMainProxyStreaming.mockResolvedValue({ data: upstream });

    const res = makeRes();
    const request = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true };

    await ollamaAdapter.handleStreamingChat(request, res);

    // The event is split across chunks, and the upstream closes the stream
    // right after the last fragment with no closing "\n\n" and no [DONE]
    // line ever completing. The carried remainder must still be parsed.
    upstream.emit('data', 'data: {"choices":[{"delta":{"content":"Hel');
    upstream.emit('data', 'lo world"}}]}');
    upstream.emit('end');

    const written = res.write.mock.calls.map(([line]) => JSON.parse(line));
    expect(written.some((line) => line.message && line.message.content === 'Hello world')).toBe(true);
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});
