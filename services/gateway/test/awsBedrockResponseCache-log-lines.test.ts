/**
 * The Bedrock response cache called its logger as `logger.info('Plugin', 'the text')`. The plugin
 * logger takes `(message, meta)`, so every line of this plugin had the message "Plugin" and its
 * real text travelled as metadata - which the stored gateway log does not keep.
 *
 * Also: a tool call's input that cannot be parsed is conversation content. It must reach the log
 * as metadata only, never inside the message (a JSON.parse error quotes a piece of its input).
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import pluginRules = require('../src/plugins/awsBedrockResponseCache/index');

const rules = pluginRules as any[];
const beforeHandler = rules.find((r) => r.strategy === 'before').handler;
const afterHandler = rules.find((r) => r.strategy === 'after').handler;
const streamHandler = rules.find((r) => r.strategy === 'stream').handler;

type Call = { level: string; args: any[] };

function recordingUtils() {
  const calls: Call[] = [];
  const logger: any = {};
  for (const level of ['info', 'warn', 'error', 'debug', 'trace']) {
    logger[level] = (...args: any[]) => { calls.push({ level, args }); };
  }
  return { utils: { logger }, calls };
}

function makeReq(text: string, url = '/anthropic/v1/model/claude-test/invoke', extra: any = {}) {
  return {
    method: 'POST',
    originalUrl: url,
    url,
    headers: {},
    body: { anthropic_version: 'bedrock-2023-05-31', messages: [{ role: 'user', content: text }], ...extra },
  } as any;
}

function makeRes() {
  const res: any = new EventEmitter();
  res.writable = true;
  res.writableEnded = false;
  res.headersSent = false;
  res.setHeader = () => {};
  res.status = () => res;
  res.json = () => res;
  res.write = () => true;
  res.end = () => { res.writableEnded = true; };
  return res;
}

const messages = (calls: Call[], level?: string) =>
  calls.filter((c) => !level || c.level === level).map((c) => c.args[0]);

afterEach(() => { jest.restoreAllMocks(); });

describe('response cache: the text of a log line is its message', () => {
  it('a cache miss, a web_search request and an after handler without a response log their text as the message', async () => {
    const { utils, calls } = recordingUtils();

    const req = makeReq('log lines: a cache miss');
    const res = makeRes();
    await beforeHandler({ req, res, utils });
    res.emit('close');

    await beforeHandler({
      req: makeReq('log lines: web search', undefined, { tools: [{ type: 'web_search_20250305', name: 'web_search' }] }),
      res: makeRes(),
      utils,
    });

    await afterHandler({ req: makeReq('log lines: never seen'), res: makeRes(), upstreamResponse: null, utils });
    await afterHandler({ req: makeReq('log lines: no context'), res: makeRes(), upstreamResponse: { ok: true }, utils });

    expect(messages(calls, 'info').some((m) => /^Cache miss for full key: [0-9a-f]{8}\.\.\.$/.test(m))).toBe(true);
    expect(messages(calls, 'info')).toContain('[awsBedrockResponseCache] NOT CACHING: request declares the web_search tool');
    expect(messages(calls, 'info')).toContain('NOT CACHING: No upstream response provided');
    expect(messages(calls, 'warn')).toContain('NOT CACHING: No context found in WeakMap for request');

    expect(calls.length).toBeGreaterThan(4);
    expect(messages(calls)).not.toContain('Plugin');
    for (const call of calls) expect(call.args.length).toBeLessThanOrEqual(2);
  });
});

/** Runs a streaming request through before, stream and after handler; the after handler sees a slow request. */
async function runStreamed(chunks: string[], text: string) {
  const { utils, calls } = recordingUtils();
  const now = 1_700_000_000_000;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

  const req = makeReq(text, '/anthropic/v1/model/claude-test/invoke-with-response-stream');
  const res = makeRes();
  await beforeHandler({ req, res, utils });
  for (const chunk of chunks) await streamHandler({ req, res, chunk: Buffer.from(chunk), utils });

  clock.mockReturnValue(now + 6000);
  await afterHandler({ req, res, upstreamResponse: { streamed: true }, utils });
  res.emit('close');
  return calls;
}

const SECRET = 'RAW-TOOL-INPUT-of-Jane-Roe';

describe('response cache: a tool call input that cannot be parsed stays out of the message', () => {
  const parseFailures = (calls: Call[]) => calls.filter((c) => c.level === 'warn' && /^Failed to parse tool use input JSON/.test(c.args[0]));

  it('Anthropic-format events', async () => {
    const sse = (event: any) => `data: ${JSON.stringify(event)}`;
    const calls = await runStreamed([
      sse({ type: 'message_start', message: { id: 'msg_1', model: 'claude-test', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }),
      sse({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } }),
      sse({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: `{"q": ${SECRET}}` } }),
      sse({ type: 'content_block_stop', index: 3 }),
    ], 'log lines: anthropic parse failure');

    const failures = parseFailures(calls);
    expect(failures).toHaveLength(1);
    expect(failures[0].args[0]).toBe('Failed to parse tool use input JSON for block 3');
    expect(failures[0].args[0]).not.toContain(SECRET);
    expect(failures[0].args[1].rawInput).toContain(SECRET);
    expect(typeof failures[0].args[1].error).toBe('string');
    expect(failures[0].args[1].error.length).toBeGreaterThan(0);
    for (const call of calls.filter((c) => ['info', 'warn', 'error'].includes(c.level))) {
      expect(String(call.args[0])).not.toContain(SECRET);
    }
  });

  it('Bedrock-format events', async () => {
    const raw = (event: any) => JSON.stringify(event);
    const calls = await runStreamed([
      raw({ messageStart: { role: 'assistant' } }),
      raw({ contentBlockStart: { start: { toolUse: { toolUseId: 'tooluse_1', name: 'lookup' } } }, contentBlockIndex: 2 }),
      raw({ contentBlockDelta: { delta: { toolUse: { input: `{"q": ${SECRET}}` } } }, contentBlockIndex: 2 }),
      raw({ contentBlockStop: {}, contentBlockIndex: 2 }),
    ], 'log lines: bedrock parse failure');

    const failures = parseFailures(calls);
    expect(failures).toHaveLength(1);
    expect(failures[0].args[0]).toBe('Failed to parse tool use input JSON for block 2');
    expect(failures[0].args[0]).not.toContain(SECRET);
    expect(failures[0].args[1].rawInput).toContain(SECRET);
    expect(typeof failures[0].args[1].error).toBe('string');
    expect(failures[0].args[1].error.length).toBeGreaterThan(0);
    for (const call of calls.filter((c) => ['info', 'warn', 'error'].includes(c.level))) {
      expect(String(call.args[0])).not.toContain(SECRET);
    }
  });
});

describe('response cache: source guard', () => {
  it('no call of the plugin logger passes the word "Plugin" as its first argument', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/awsBedrockResponseCache/index.ts'), 'utf8');
    // Above this marker sits the LRUCache class, which uses the gateway logger (component, message):
    // there 'Plugin' is the component and correct. Below it, every call is on the plugin logger (message, meta).
    const pluginPart = source.slice(source.indexOf('// Plugin configuration'));
    expect(pluginPart.length).toBeGreaterThan(1000);
    expect(pluginPart).not.toMatch(/logger\.(info|warn|error|debug|trace)\(\s*'Plugin'/);
  });
});
