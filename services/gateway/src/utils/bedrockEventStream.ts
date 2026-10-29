/**
 * AWS event stream framing for the /aws-bedrock streaming subpaths.
 *
 * Bedrock answers invoke-with-response-stream and converse-stream in AWS's binary
 * event stream (application/vnd.amazon.eventstream); boto3, the AWS SDKs and the
 * Anthropic Bedrock SDK decode only that, and Claude Code >= 2.1.308 refuses a
 * text/event-stream body outright. The gateway itself builds these streams as SSE
 * (SAP AI Core streams SSE, and the cache, pseudonymization, tool and usage taps all
 * read SSE), so the conversion happens here, on `res`, as the last step before the
 * socket: everything above keeps writing and observing SSE.
 *
 * Frame layout: total length (u32) | headers length (u32) | prelude CRC32 |
 * headers (name len u8, name, type 7 = string, value len u16, value) | payload | message CRC32.
 */
import { Response } from 'express';
import { StringDecoder } from 'string_decoder';
import { createParser, EventSourceMessage } from 'eventsource-parser';
import { getDefaultLogger } from '@libs/logger';
import { parseConverseEventData } from './converseEventData';
const logger = getDefaultLogger();

export const EVENT_STREAM_CONTENT_TYPE = 'application/vnd.amazon.eventstream';

// CRC-32 (IEEE), table-driven; zlib.crc32 needs Node >= 20.15 and the gateway supports >= 20.9.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One event stream message with string headers. */
export function encodeEventStreamMessage(headers: Record<string, string>, payload: Buffer): Buffer {
  const headerParts: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const valueBuf = Buffer.from(value, 'utf8');
    const head = Buffer.alloc(1 + nameBuf.length + 3);
    head.writeUInt8(nameBuf.length, 0);
    nameBuf.copy(head, 1);
    head.writeUInt8(7, 1 + nameBuf.length);
    head.writeUInt16BE(valueBuf.length, 2 + nameBuf.length);
    headerParts.push(head, valueBuf);
  }
  const headerBuf = Buffer.concat(headerParts);
  const total = 12 + headerBuf.length + payload.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(headerBuf.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const body = Buffer.concat([prelude, headerBuf, payload]);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([body, trailer]);
}

const eventFrame = (eventType: string, payload: unknown): Buffer =>
  encodeEventStreamMessage(
    { ':event-type': eventType, ':content-type': 'application/json', ':message-type': 'event' },
    Buffer.from(JSON.stringify(payload), 'utf8'));

const exceptionFrame = (exceptionType: string, message: string): Buffer =>
  encodeEventStreamMessage(
    { ':message-type': 'exception', ':exception-type': exceptionType, ':content-type': 'application/json' },
    Buffer.from(JSON.stringify({ message }), 'utf8'));

/** Bedrock's exception type for an Anthropic error type or an HTTP status. */
function exceptionTypeOf(errorType: unknown, code: unknown): string {
  switch (errorType) {
    case 'rate_limit_error': return 'throttlingException';
    case 'invalid_request_error': return 'validationException';
    case 'authentication_error':
    case 'permission_error': return 'accessDeniedException';
    case 'not_found_error': return 'resourceNotFoundException';
    case 'overloaded_error': return 'serviceUnavailableException';
    case 'timeout_error': return 'modelTimeoutException';
  }
  switch (Number(code)) {
    case 429: return 'throttlingException';
    case 400: case 413: case 422: return 'validationException';
    case 401: case 403: return 'accessDeniedException';
    case 404: return 'resourceNotFoundException';
    case 408: case 504: return 'modelTimeoutException';
    case 503: case 529: return 'serviceUnavailableException';
  }
  return 'internalServerException';
}

const CONVERSE_EVENTS = ['messageStart', 'contentBlockStart', 'contentBlockDelta', 'contentBlockStop', 'messageStop', 'metadata'];
const BLOCK_EVENTS = new Set(['contentBlockStart', 'contentBlockDelta', 'contentBlockStop']);

/** Usage and stop reason collected from Anthropic events for the closing Converse frames. */
interface ConverseState {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  stopReason: string;
  latencyMs: number;
}

/** Anthropic stream events (what the emulated path writes) → Converse stream frames. */
function anthropicToConverse(event: any, state: ConverseState): Buffer[] {
  const index = event.index ?? 0;
  switch (event.type) {
    case 'message_start': {
      const usage = event.message?.usage || {};
      state.inputTokens = usage.input_tokens || 0;
      state.outputTokens = usage.output_tokens || 0;
      state.cacheReadInputTokens = usage.cache_read_input_tokens || 0;
      state.cacheWriteInputTokens = usage.cache_creation_input_tokens || 0;
      return [eventFrame('messageStart', { role: event.message?.role || 'assistant' })];
    }
    case 'content_block_start': {
      const block = event.content_block;
      if (block?.type !== 'tool_use') return []; // Converse opens text and reasoning blocks with their first delta
      return [eventFrame('contentBlockStart', { contentBlockIndex: index, start: { toolUse: { toolUseId: block.id, name: block.name } } })];
    }
    case 'content_block_delta': {
      const d = event.delta || {};
      let delta: any;
      if (d.type === 'text_delta') delta = { text: d.text };
      else if (d.type === 'input_json_delta') delta = { toolUse: { input: d.partial_json } };
      else if (d.type === 'thinking_delta') delta = { reasoningContent: { text: d.thinking } };
      else if (d.type === 'signature_delta') delta = { reasoningContent: { signature: d.signature } };
      else return [];
      return [eventFrame('contentBlockDelta', { contentBlockIndex: index, delta })];
    }
    case 'content_block_stop':
      return [eventFrame('contentBlockStop', { contentBlockIndex: index })];
    case 'message_delta':
      if (event.delta?.stop_reason) state.stopReason = event.delta.stop_reason;
      if (event.usage?.output_tokens !== undefined) state.outputTokens = event.usage.output_tokens;
      if (event.usage?.input_tokens) state.inputTokens = event.usage.input_tokens;
      return [];
    case 'message_stop': {
      const metrics = event['amazon-bedrock-invocationMetrics'];
      if (metrics) {
        state.inputTokens = metrics.inputTokenCount ?? state.inputTokens;
        state.outputTokens = metrics.outputTokenCount ?? state.outputTokens;
        state.cacheReadInputTokens = metrics.cacheReadInputTokenCount ?? state.cacheReadInputTokens;
        state.cacheWriteInputTokens = metrics.cacheWriteInputTokenCount ?? state.cacheWriteInputTokens;
        state.latencyMs = metrics.invocationLatency ?? state.latencyMs;
      }
      const usage: Record<string, number> = {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.inputTokens + state.outputTokens,
      };
      if (state.cacheReadInputTokens) usage.cacheReadInputTokens = state.cacheReadInputTokens;
      if (state.cacheWriteInputTokens) usage.cacheWriteInputTokens = state.cacheWriteInputTokens;
      return [
        eventFrame('messageStop', { stopReason: state.stopReason }),
        eventFrame('metadata', { usage, metrics: { latencyMs: state.latencyMs } }),
      ];
    }
    default:
      return []; // ping: Converse has no keep-alive event
  }
}

/** The frames for one SSE event of a stream answered on `subpath`. */
function framesFor(message: EventSourceMessage, subpath: string, state: ConverseState): Buffer[] {
  if (message.data === '[DONE]') return [];
  // SAP streams a deployed model's native Converse events as single-quoted dicts, not JSON.
  let raw = message.data;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    try {
      data = parseConverseEventData(raw);
      raw = JSON.stringify(data);
    } catch {
      logger.debug('BedrockEventStream', `Dropping an unparseable SSE event (${raw.length} bytes)`);
      return [];
    }
  }
  if (!data || typeof data !== 'object') return [];

  if (message.event === 'error' || data.type === 'error' || (data.error && !data.type)) {
    const error = typeof data.error === 'object' && data.error ? data.error : { message: data.error };
    return [exceptionFrame(exceptionTypeOf(error.type, error.code ?? error.status), error.message || 'Internal server error')];
  }

  if (subpath === 'converse-stream') {
    const name = CONVERSE_EVENTS.find((key) => data[key] !== undefined);
    if (name) {
      const payload = { ...data[name] };
      if (BLOCK_EVENTS.has(name) && payload.contentBlockIndex === undefined && data.contentBlockIndex !== undefined) {
        payload.contentBlockIndex = data.contentBlockIndex;
      }
      return [eventFrame(name, payload)];
    }
    return anthropicToConverse(data, state);
  }

  // invoke-with-response-stream: each model event travels base64-encoded in a chunk.
  return [eventFrame('chunk', { bytes: Buffer.from(raw, 'utf8').toString('base64') })];
}

/**
 * Answer this streaming response in AWS event stream framing. Call before anything
 * writes to `res` or wraps its write/end. A response that turns into an error before
 * its first frame (status >= 400, or a JSON body) goes out unchanged as application/json.
 */
export function installBedrockEventStream(res: Response, subpath: string): void {
  const state: ConverseState = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, stopReason: 'end_turn', latencyMs: 0 };
  const decoder = new StringDecoder('utf8');
  let pending: Buffer[] = [];
  const parser = createParser({ onEvent: (message) => { pending.push(...framesFor(message, subpath, state)); } });
  /** undefined until the first write decides: frames, or a plain (error) body. */
  let mode: 'frames' | 'plain' | undefined;

  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: any) => {
    if (name.toLowerCase() === 'content-type' && mode !== 'plain' && String(value).startsWith('text/event-stream')) {
      return setHeader(name, EVENT_STREAM_CONTENT_TYPE);
    }
    return setHeader(name, value);
  }) as typeof res.setHeader;
  setHeader('Content-Type', EVENT_STREAM_CONTENT_TYPE);

  const decide = (chunk: any): void => {
    if (mode) return;
    const text = chunk == null ? '' : (Buffer.isBuffer(chunk) ? chunk.toString('utf8', 0, 64) : String(chunk).slice(0, 64)).trimStart();
    if (res.statusCode >= 400 || text.startsWith('{')) {
      mode = 'plain';
      if (!res.headersSent) setHeader('Content-Type', 'application/json; charset=utf-8');
    } else if (text) {
      mode = 'frames';
    }
  };
  const toFrames = (chunk: any, encoding?: BufferEncoding): Buffer | undefined => {
    if (chunk != null) parser.feed(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8')));
    const out = pending.length ? Buffer.concat(pending) : undefined;
    pending = [];
    return out;
  };

  if (typeof res.write === 'function') {
    const write = res.write.bind(res) as (...args: any[]) => boolean;
    res.write = ((chunk: any, encoding?: any, callback?: any) => {
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      decide(chunk);
      if (mode === 'plain') return write(chunk, encoding, callback);
      const frames = toFrames(chunk, encoding);
      if (frames) return write(frames, callback);
      if (callback) process.nextTick(callback);
      return true;
    }) as typeof res.write;
  }

  if (typeof res.end === 'function') {
    const end = res.end.bind(res) as (...args: any[]) => Response;
    res.end = ((chunk?: any, encoding?: any, callback?: any) => {
      if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      decide(chunk);
      if (mode === 'plain') return end(chunk, encoding, callback);
      toFrames(chunk, encoding);
      parser.feed(decoder.end());
      parser.feed('\n\n'); // an event still missing its blank line ends with the stream (an empty one sends nothing)
      const frames = toFrames(undefined);
      return frames ? end(frames, callback) : end(callback);
    }) as typeof res.end;
  }
}
