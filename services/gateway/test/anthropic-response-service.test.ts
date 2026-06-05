/**
 * Anthropic Response Service Tests
 *
 * Tests for the stop_reason mapping and tool_use input handling
 * in transformSAPResponseToAnthropic.
 */
import { describe, it, expect, jest } from '@jest/globals';

// Mock dependencies
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
    getModelDetails: () => Promise.resolve({ owned_by: 'anthropic' }),
  },
}));

jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: {
    getSubstitutedModel: (_provider: string, model: string) => model,
  },
}));

import anthropicResponseService from '../src/services/anthropicResponseService';

/**
 * Helper: build a minimal SAP response with the given finish_reason and optional tool_calls.
 */
function buildSAPResponse(options: {
  finishReason?: string;
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>;
}): any {
  const message: Record<string, any> = {};

  if (options.content !== undefined) {
    message.content = options.content;
  }

  if (options.toolCalls) {
    message.tool_calls = options.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));
  }

  const choice: Record<string, any> = { message };
  if (options.finishReason !== undefined) {
    choice.finish_reason = options.finishReason;
  }

  return {
    request_id: 'req-test',
    intermediate_results: { templating: [] },
    final_result: {
      id: 'test-id',
      model: 'test-model',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      choices: [choice],
    },
  };
}

describe('AnthropicResponseService', () => {
  describe('transformSAPResponseToAnthropic — stop_reason mapping', () => {
    it('should map finish_reason "tool_calls" to stop_reason "tool_use"', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'tool_calls',
        content: 'I will call a tool.',
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{"query":"test"}' }],
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      expect(result.stop_reason).toBe('tool_use');
    });

    it('should map finish_reason "tool_use" to stop_reason "tool_use"', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'tool_use',
        content: 'Calling tool.',
        toolCalls: [{ id: 'call_2', name: 'get_weather', arguments: '{"city":"Berlin"}' }],
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      expect(result.stop_reason).toBe('tool_use');
    });

    it('should map finish_reason "stop" to stop_reason "end_turn"', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'stop',
        content: 'Done.',
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      expect(result.stop_reason).toBe('end_turn');
    });

    it('should map finish_reason "end_turn" to stop_reason "end_turn"', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'end_turn',
        content: 'Finished.',
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      expect(result.stop_reason).toBe('end_turn');
    });

    it('should map finish_reason "length" to stop_reason "max_tokens"', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'length',
        content: 'Truncated output...',
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      expect(result.stop_reason).toBe('max_tokens');
    });

    it('should map finish_reason "stop_sequences" to stop_reason "stop_sequence"', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'stop_sequences',
        content: 'Stopped at sequence.',
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      expect(result.stop_reason).toBe('stop_sequence');
    });

    it('should default to "end_turn" when finish_reason is absent', async () => {
      const sapResponse = buildSAPResponse({
        content: 'Hello.',
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      expect(result.stop_reason).toBe('end_turn');
    });
  });

  describe('transformSAPResponseToAnthropic — tool_use content blocks', () => {
    it('should parse tool arguments into input object', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'tool_calls',
        content: 'Searching.',
        toolCalls: [{
          id: 'call_abc',
          name: 'web_search',
          arguments: '{"query":"current date April 2026"}',
        }],
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      const toolUseBlock = result.content.find((b: any) => b.type === 'tool_use');
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock.id).toBe('call_abc');
      expect(toolUseBlock.name).toBe('web_search');
      expect(toolUseBlock.input).toEqual({ query: 'current date April 2026' });
    });

    it('should produce empty input when tool arguments are missing', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'tool_calls',
        content: 'Calling tool.',
        toolCalls: [{
          id: 'call_no_args',
          name: 'web_search',
          // no arguments
        }],
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      const toolUseBlock = result.content.find((b: any) => b.type === 'tool_use');
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock.input).toEqual({});
    });

    it('should handle malformed JSON arguments with raw_arguments fallback', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'tool_calls',
        content: 'Calling.',
        toolCalls: [{
          id: 'call_bad_json',
          name: 'web_search',
          arguments: '{broken json',
        }],
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      const toolUseBlock = result.content.find((b: any) => b.type === 'tool_use');
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock.input).toEqual({ raw_arguments: '{broken json' });
    });

    it('should include both text and tool_use content blocks', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'tool_calls',
        content: 'Let me search for that.',
        toolCalls: [{
          id: 'call_mixed',
          name: 'web_search',
          arguments: '{"query":"test"}',
        }],
      });

      const result: any = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, false, 'test-model'
      );

      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Let me search for that.' });
      expect(result.content[1].type).toBe('tool_use');
    });
  });

  describe('transformSAPResponseToAnthropic — streaming early return', () => {
    it('should return empty object for streaming responses', async () => {
      const sapResponse = buildSAPResponse({
        finishReason: 'stop',
        content: 'Hello.',
      });

      const result = await anthropicResponseService.transformSAPResponseToAnthropic(
        sapResponse, true, 'test-model'
      );

      expect(result).toEqual({});
    });
  });
});
