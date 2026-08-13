/**
 * T6: `transformBedrockToAnthropicResponse` must fold Bedrock Converse
 * (non-streaming, `invoke` subpath) cache token fields into the Anthropic-shaped
 * `usage` object it returns, so the downstream 5-arg `updateTokenCounts` fold in
 * anthropicController.ts (which reads `cache_creation_input_tokens` /
 * `cache_read_input_tokens`) actually sees non-zero cache activity instead of
 * always folding `undefined -> 0`.
 *
 * Cache field names on the raw Bedrock `usage` object (`cacheReadInputTokens` /
 * `cacheWriteInputTokens`) are per AWS docs, unconfirmed by any capture in this
 * repo — see task-T6 report. No local capture exercises the raw Converse
 * (non-streaming) response shape; every captured Bedrock response under
 * services/gateway/logs/payloads went through the SAP native Anthropic
 * passthrough route instead, which is already Anthropic-shaped.
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
  createSafePreview: jest.fn(() => ''),
  createHeadersPreview: jest.fn(() => ''),
}));

import { transformBedrockToAnthropicResponse } from '../src/services/awsBedrockService';

describe('transformBedrockToAnthropicResponse — cache token mapping (T6)', () => {
  it('maps cacheReadInputTokens/cacheWriteInputTokens into cache_read_input_tokens/cache_creation_input_tokens', () => {
    const bedrockResponse: any = {
      output: { message: { content: [{ text: 'hi' }] } },
      stopReason: 'end_turn',
      usage: {
        inputTokens: 12,
        outputTokens: 34,
        cacheReadInputTokens: 5000,
        cacheWriteInputTokens: 250,
      },
      responseMetadata: { requestId: 'req-1' },
    };

    const result = transformBedrockToAnthropicResponse(bedrockResponse, 'invoke', 'claude-test');

    expect(result.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      cache_creation_input_tokens: 250,
      cache_read_input_tokens: 5000,
    });
  });

  it('defaults cache fields to 0 when the Converse response carries none (backward compat)', () => {
    const bedrockResponse: any = {
      output: { message: { content: [{ text: 'hi' }] } },
      stopReason: 'end_turn',
      usage: {
        inputTokens: 7,
        outputTokens: 3,
      },
      responseMetadata: { requestId: 'req-2' },
    };

    const result = transformBedrockToAnthropicResponse(bedrockResponse, 'invoke', 'claude-test');

    expect(result.usage).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('leaves other subpaths untouched (no usage transform applied)', () => {
    const bedrockResponse: any = { some: 'raw-converse-shape', usage: { inputTokens: 1 } };
    const result = transformBedrockToAnthropicResponse(bedrockResponse, 'converse', 'claude-test');
    expect(result).toBe(bedrockResponse);
  });
});
