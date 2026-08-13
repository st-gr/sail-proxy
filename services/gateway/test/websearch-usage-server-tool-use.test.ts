/**
 * `usage.server_tool_use.web_search_requests` is the field Claude Code counts.
 *
 * Verified against a real api.anthropic.com capture (2026-08-07): a turn with
 * one search reports `{"web_search_requests":1,"web_fetch_requests":0}` on the
 * message_delta. Without it a client shows "0 searches executed" even when the
 * search ran and its results are in the content.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../src/plugins/webSearch/searchExecutor', () => ({
  executeWebSearch: jest.fn(async () => ([
    {
      title: 'Zig Downloads',
      url: 'https://ziglang.org/download/',
      snippet: 'Zig 0.16.0',
      // buildResponseWithSearchResults base64-encodes this unconditionally
      // (Buffer.from(result.content)) — omitting it throws, which afterHandler's
      // catch block swallows and silently reverts to the unmodified upstream
      // response, masking the very field this test is checking for.
      content: 'Zig 0.16.0 is available for download.',
    },
  ])),
}));

const rules = require('../src/plugins/webSearchPlugin');
const afterRule = rules.find((r: any) => r.strategy === 'after');

function upstreamWithSearchCall() {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'zig version' } }],
    usage: { input_tokens: 10, output_tokens: 4 },
  };
}

describe('webSearchPlugin afterHandler usage', () => {
  it('adds server_tool_use with the number of searches actually run', async () => {
    const req: any = {
      body: {
        model: 'anthropic--claude-4.5-haiku--deployed',
        // hasWebSearchTool gates the whole afterHandler on this; without it the
        // handler returns upstreamResponse unchanged before it ever looks at content.
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      },
    };
    const out: any = await afterRule.handler({
      req, res: {} as any, utils: { logger: console as any }, upstreamResponse: upstreamWithSearchCall(),
    });

    expect(out.usage.server_tool_use).toEqual({ web_search_requests: 1, web_fetch_requests: 0 });
    // Every pre-existing usage key survives.
    expect(out.usage.input_tokens).toBe(10);
    expect(out.usage.output_tokens).toBe(4);
  });

  it('leaves usage untouched when no search ran', async () => {
    const req: any = {
      body: {
        model: 'anthropic--claude-4.5-haiku--deployed',
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      },
    };
    const noCall = { ...upstreamWithSearchCall(), content: [{ type: 'text', text: 'hi' }] };
    const out: any = await afterRule.handler({
      req, res: {} as any, utils: { logger: console as any }, upstreamResponse: noCall,
    });

    expect(out.usage.server_tool_use).toBeUndefined();
  });
});
