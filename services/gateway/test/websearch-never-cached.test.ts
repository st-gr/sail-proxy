/**
 * A web_search turn must never be served from, or written to, the response cache.
 *
 * `api_config.json` wires `awsBedrockResponseCache` onto
 * `hooks/invoke-with-response-stream` for every Anthropic model, matched on
 * `size:min61kb` — a threshold a real Claude Code request clears routinely. Two
 * consequences, both of which defeat the streaming web_search interception:
 *
 *  - SERVING. A cache hit returns `{ stop: true }` from the before-handler, so
 *    `handleNativeStreamingRequest` never runs and the interception is never
 *    installed.
 *  - STORING. The stream handler captures the RAW upstream chunk, before
 *    `BedrockStreamParser.processChunk` and therefore before the interception,
 *    so what gets stored is the un-rewritten `tool_use` turn.
 *
 * Together: one uncached web_search request poisons the cache, and every later
 * hit silently replays the exact bug this branch fixes, with no upstream call to
 * notice it by. Search results are also time-sensitive and have no business in a
 * response cache regardless.
 *
 * The guard works by returning before `requestContextMap.set(req, ...)`. The
 * stream, after and error handlers all begin by looking that context up and pass
 * through untouched when it is missing, so the single early return covers every
 * direction. These tests assert exactly that observable contract.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import pluginRules = require('../src/plugins/awsBedrockResponseCache');

const rules = pluginRules as any[];
const beforeHandler = rules.find((r) => r.strategy === 'before').handler;
const afterHandler = rules.find((r) => r.strategy === 'after').handler;
const streamHandler = rules.find((r) => r.strategy === 'stream').handler;

const utils = {
  logger: {
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  },
};

/** A streaming Anthropic request, the shape the cache hook actually matches. */
function makeReq(tools: any[] | undefined) {
  return {
    method: 'POST',
    originalUrl: '/anthropic/v1/model/claude-test/invoke-with-response-stream',
    url: '/anthropic/v1/model/claude-test/invoke-with-response-stream',
    headers: {},
    body: {
      anthropic_version: 'bedrock-2023-05-31',
      messages: [{ role: 'user', content: 'what is the current zig version' }],
      ...(tools ? { tools } : {}),
    },
  } as any;
}

function makeRes() {
  const res: any = { chunks: [] as string[] };
  res.writable = true;
  res.writableEnded = false;
  res.headersSent = false;
  res.setHeader = () => {};
  res.write = (c: any) => { res.chunks.push(String(c)); return true; };
  res.end = () => { res.writableEnded = true; };
  return res;
}

const SERVER_TOOL = [{ type: 'web_search_20250305', name: 'web_search' }];
const REWRITTEN_TOOL = [{
  name: 'web_search',
  description: 'Search the web',
  input_schema: { type: 'object', properties: { query: { type: 'string' } } },
}];
const ORDINARY_TOOLS = [{ name: 'Read', input_schema: { type: 'object' } }];

/** The raw pre-interception chunk the stream handler would otherwise capture. */
const RAW_TOOL_USE_CHUNK = Buffer.from(
  'data: {"type":"content_block_start","index":0,"content_block":'
  + '{"type":"tool_use","id":"toolu_1","name":"web_search","input":{}}}\n\n',
);

describe('awsBedrockResponseCache — web_search is never cached', () => {
  beforeEach(() => {
    utils.logger.info.mockClear();
  });

  // Both spellings, because which one is present depends on whether the cache
  // hook runs before or after webSearchPlugin's rewrite of the server tool.
  for (const [label, tools] of [
    ['the server tool (web_search_20250305)', SERVER_TOOL],
    ['the rewritten function tool (name: web_search)', REWRITTEN_TOOL],
  ] as const) {
    it(`declines to cache a request declaring ${label}`, async () => {
      const req = makeReq(tools as any[]);
      const result = await beforeHandler({ req, res: makeRes(), utils });

      // Never serves: the request continues to the real upstream handler, which
      // is where the interception gets installed.
      expect(result).toEqual({ stop: false });

      // Never stores: with no context recorded, the stream handler passes the
      // chunk through and captures nothing...
      const streamed = await streamHandler({ req, chunk: RAW_TOOL_USE_CHUNK, utils });
      expect(streamed.chunk).toBe(RAW_TOOL_USE_CHUNK);
      expect(streamed.capturedEvents).toEqual([]);

      // ...and the after handler stores nothing either.
      const upstream = { content: [{ type: 'text', text: 'hi' }] };
      await expect(afterHandler({ req, upstreamResponse: upstream, utils })).resolves.toBe(upstream);
    });
  }

  it('still caches an ordinary streaming request that declares other tools', async () => {
    // The guard must be narrow: this plugin exists to cache, and disarming it
    // for every tool-bearing request would be a silent performance regression.
    const req = makeReq(ORDINARY_TOOLS);
    const result = await beforeHandler({ req, res: makeRes(), utils });

    expect(result).toEqual({ stop: false });   // miss, not a refusal
    // Context WAS recorded, so the stream handler now captures events.
    const streamed = await streamHandler({ req, chunk: RAW_TOOL_USE_CHUNK, utils });
    expect(streamed.capturedEvents.length).toBeGreaterThan(0);
  });

  it('still caches a streaming request with no tools at all', async () => {
    const req = makeReq(undefined);
    await beforeHandler({ req, res: makeRes(), utils });
    const streamed = await streamHandler({ req, chunk: RAW_TOOL_USE_CHUNK, utils });
    expect(streamed.capturedEvents.length).toBeGreaterThan(0);
  });
});

describe('buildWebSearchToolResultContent', () => {
  // What the MODEL reads back from a search must not depend on whether the
  // request arrived streaming or not. The two paths had drifted into identical
  // copies of this builder; one of them now has to change if the other does.
  const RESULTS = [
    { title: 'Zig Downloads', url: 'https://ziglang.org/download/', snippet: 'ignored', content: 'Zig 0.16.0 is current.', date: 'February 13, 2026' },
    { title: 'Release Notes', url: 'https://ziglang.org/notes/', snippet: 'ignored', content: 'What changed in 0.16.0.' },
  ];

  it('carries title, url, content and date, and drops snippet', async () => {
    const { buildWebSearchToolResultContent } = await import('../src/plugins/webSearch/webSearchTool');
    const parsed = JSON.parse(buildWebSearchToolResultContent(RESULTS));

    expect(parsed.results).toEqual([
      { title: 'Zig Downloads', url: 'https://ziglang.org/download/', content: 'Zig 0.16.0 is current.', date: 'February 13, 2026' },
      { title: 'Release Notes', url: 'https://ziglang.org/notes/', content: 'What changed in 0.16.0.' },
    ]);
    // `snippet` is deliberately absent — `content` already carries the body, and
    // this is the shape the non-streaming path has always sent.
    expect(JSON.stringify(parsed)).not.toContain('ignored');
  });

  it('says so in prose when there is nothing to report', async () => {
    const { buildWebSearchToolResultContent } = await import('../src/plugins/webSearch/webSearchTool');
    expect(buildWebSearchToolResultContent([])).toBe('No search results found.');
  });
});
