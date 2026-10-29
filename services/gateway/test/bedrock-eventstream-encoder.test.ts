/**
 * The /aws-bedrock streaming subpaths answer in AWS's binary event stream
 * (application/vnd.amazon.eventstream), as Bedrock does. The gateway builds its
 * streams as SSE (SAP AI Core streams SSE; the cache, pseudonymization, tool and
 * usage taps all read SSE), so the encoder sits on `res` and turns each SSE event
 * into a frame on the way out. Claude Code >= 2.1.308 refuses a Bedrock stream
 * whose content type is text/event-stream; boto3 and the AWS SDKs never parsed one.
 *
 * Each test runs a real HTTP server, writes through the gateway's own sseWriter,
 * and reads the raw bytes back with an independent decoder (bedrockEventStreamDecoder).
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import * as sseWriter from '../src/utils/sseWriter';
import { installBedrockEventStream } from '../src/utils/bedrockEventStream';
import { decodeEventStream, payloadJson, chunkEvent } from './bedrockEventStreamDecoder';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** Serves `handler` on 127.0.0.1 with the encoder installed for `subpath`, returns status, type and body. */
async function serve(subpath: string, handler: (res: express.Response) => void | Promise<void>) {
  const app = express();
  app.post('/model/m/:subpath', async (_req, res) => {
    installBedrockEventStream(res, subpath);
    await handler(res);
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = server!.address() as AddressInfo;
  const r = await fetch(`http://127.0.0.1:${port}/model/m/${subpath}`, { method: 'POST' });
  return { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) };
}

const anthropicText = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 4 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'po' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ng' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
  ['message_stop', { type: 'message_stop', 'amazon-bedrock-invocationMetrics': { inputTokenCount: 12, outputTokenCount: 3, invocationLatency: 420, firstByteLatency: 100 } }],
] as const;

describe('invoke-with-response-stream: Anthropic events become Bedrock chunk frames', () => {
  it('sends application/vnd.amazon.eventstream with one chunk frame per event, bytes intact', async () => {
    const { status, type, body } = await serve('invoke-with-response-stream', (res) => {
      for (const [name, data] of anthropicText) sseWriter.writeEventStream(res, name, JSON.stringify(data));
      res.end();
    });
    expect(status).toBe(200);
    expect(type).toBe('application/vnd.amazon.eventstream');
    const frames = decodeEventStream(body);
    expect(frames.map((f) => f.headers)).toEqual(anthropicText.map(() => ({
      ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event',
    })));
    expect(frames.map(chunkEvent)).toEqual(anthropicText.map(([, data]) => data));
  });

  it('a keep-alive ping is a ping chunk; the SSE comment and [DONE] send nothing', async () => {
    const { body } = await serve('invoke-with-response-stream', (res) => {
      sseWriter.writePing(res); // ": ping" comment + event: ping
      res.write('data: [DONE]\n\n');
      res.end();
    });
    expect(decodeEventStream(body).map(chunkEvent)).toEqual([{ type: 'ping' }]);
  });

  it('an event split across writes, and a UTF-8 character split across Buffers, arrive whole', async () => {
    const event = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Grüße 🙂' } };
    const wire = Buffer.from(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`, 'utf8');
    const cut = wire.indexOf(Buffer.from('🙂')) + 2; // inside the 4-byte emoji
    const { body } = await serve('invoke-with-response-stream', (res) => {
      res.write(wire.subarray(0, 10));
      res.write(wire.subarray(10, cut));
      res.write(wire.subarray(cut));
      res.end();
    });
    expect(decodeEventStream(body).map(chunkEvent)).toEqual([event]);
  });

  it('an SSE event still unterminated when the response ends is flushed, not dropped', async () => {
    const { body } = await serve('invoke-with-response-stream', (res) => {
      res.end('event: message_stop\ndata: {"type":"message_stop"}');
    });
    expect(decodeEventStream(body).map(chunkEvent)).toEqual([{ type: 'message_stop' }]);
  });
});

describe('errors', () => {
  it.each([
    [429, 'rate_limit_error', 'throttlingException'],
    [400, 'invalid_request_error', 'validationException'],
    [403, 'permission_error', 'accessDeniedException'],
    [404, 'not_found_error', 'resourceNotFoundException'],
    [503, 'overloaded_error', 'serviceUnavailableException'],
    [500, 'api_error', 'internalServerException'],
  ])('a mid-stream error (%i %s) is an exception frame of type %s', async (code, errType, exceptionType) => {
    const { body } = await serve('invoke-with-response-stream', (res) => {
      sseWriter.writeEventStream(res, 'message_start', JSON.stringify(anthropicText[0][1]));
      sseWriter.writeError(res, { error: { message: 'upstream said no', type: errType, code } });
      res.end();
    });
    const frames = decodeEventStream(body);
    expect(frames).toHaveLength(2);
    expect(frames[1].headers).toEqual({ ':message-type': 'exception', ':exception-type': exceptionType, ':content-type': 'application/json' });
    expect(payloadJson(frames[1])).toEqual({ message: 'upstream said no' });
  });

  it('an Anthropic-shaped `event: error` is an exception frame too', async () => {
    const { body } = await serve('invoke-with-response-stream', (res) => {
      sseWriter.writeEventStream(res, 'error', JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }));
      res.end();
    });
    const [frame] = decodeEventStream(body);
    expect(frame.headers[':exception-type']).toBe('serviceUnavailableException');
    expect(payloadJson(frame)).toEqual({ message: 'busy' });
  });

  it('an error answered before any frame keeps its status and JSON body, as application/json', async () => {
    const { status, type, body } = await serve('invoke-with-response-stream', (res) => {
      res.status(429).json({ error: { message: 'quota exceeded', type: 'rate_limit_error', code: 429 } });
    });
    expect(status).toBe(429);
    expect(type).toMatch(/^application\/json/);
    expect(JSON.parse(body.toString('utf8'))).toEqual({ error: { message: 'quota exceeded', type: 'rate_limit_error', code: 429 } });
  });
});

describe('converse-stream: Converse event frames', () => {
  it('Converse-shaped SSE events become typed frames carrying the inner object', async () => {
    const { type, body } = await serve('converse-stream', (res) => {
      sseWriter.writeChunk(res, { messageStart: { role: 'assistant' } });
      sseWriter.writeChunk(res, { contentBlockDelta: { delta: { text: 'pong' } }, contentBlockIndex: 0 });
      sseWriter.writeChunk(res, { contentBlockStop: { contentBlockIndex: 0 } });
      sseWriter.writeChunk(res, { messageStop: { stopReason: 'end_turn' } });
      sseWriter.writeChunk(res, { metadata: { usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 }, metrics: { latencyMs: 300 } } });
      res.end();
    });
    expect(type).toBe('application/vnd.amazon.eventstream');
    const frames = decodeEventStream(body);
    expect(frames.map((f) => f.headers[':event-type'])).toEqual(['messageStart', 'contentBlockDelta', 'contentBlockStop', 'messageStop', 'metadata']);
    expect(frames.every((f) => f.headers[':message-type'] === 'event')).toBe(true);
    expect(frames.map(payloadJson)).toEqual([
      { role: 'assistant' },
      { contentBlockIndex: 0, delta: { text: 'pong' } },
      { contentBlockIndex: 0 },
      { stopReason: 'end_turn' },
      { usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 }, metrics: { latencyMs: 300 } },
    ]);
  });

  it('SAP\'s native Converse stream, single-quoted dicts rather than JSON, is framed too', async () => {
    // What a deployed model's converse-stream returns from SAP AI Core (captured 2026-10-22).
    const { body } = await serve('converse-stream', (res) => {
      res.write("data: {'messageStart': {'role': 'assistant'}}\n\n");
      res.write("data: {'contentBlockDelta': {'delta': {'text': 'pong'}, 'contentBlockIndex': 0}}\n\n");
      res.write("data: {'messageStop': {'stopReason': 'end_turn'}}\n\n");
      res.end();
    });
    const frames = decodeEventStream(body);
    expect(frames.map((f) => [f.headers[':event-type'], payloadJson(f)])).toEqual([
      ['messageStart', { role: 'assistant' }],
      ['contentBlockDelta', { delta: { text: 'pong' }, contentBlockIndex: 0 }],
      ['messageStop', { stopReason: 'end_turn' }],
    ]);
  });

  it('Anthropic events (the emulated path writes them) are mapped to Converse events', async () => {
    const toolTurn = [
      ['message_start', { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['ping', { type: 'ping' }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }],
      ['message_stop', { type: 'message_stop' }],
    ] as const;
    const { body } = await serve('converse-stream', (res) => {
      for (const [name, data] of toolTurn) sseWriter.writeEventStream(res, name, JSON.stringify(data));
      res.end();
    });
    const frames = decodeEventStream(body);
    expect(frames.map((f) => [f.headers[':event-type'], payloadJson(f)])).toEqual([
      ['messageStart', { role: 'assistant' }],
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Reading.' } }],
      ['contentBlockStop', { contentBlockIndex: 0 }],
      ['contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'toolu_1', name: 'read' } } }],
      ['contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"path":"a"}' } } }],
      ['contentBlockStop', { contentBlockIndex: 1 }],
      ['messageStop', { stopReason: 'tool_use' }],
      ['metadata', { usage: { inputTokens: 20, outputTokens: 9, totalTokens: 29, cacheReadInputTokens: 8, cacheWriteInputTokens: 2 }, metrics: { latencyMs: 0 } }],
    ]);
  });

  it('thinking deltas become reasoningContent deltas', async () => {
    const { body } = await serve('converse-stream', (res) => {
      sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }));
      sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }));
      res.end();
    });
    expect(decodeEventStream(body).map(payloadJson)).toEqual([
      { contentBlockIndex: 0, delta: { reasoningContent: { text: 'hmm' } } },
      { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig' } } },
    ]);
  });
});

describe('the Anthropic route is not touched', () => {
  it('without the encoder, the same writes stay SSE', async () => {
    const app = express();
    app.post('/x', (_req, res) => { sseWriter.writeEventStream(res, 'message_stop', '{"type":"message_stop"}'); res.end(); });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    const { port } = server!.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST' });
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(await r.text()).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
});
