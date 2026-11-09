/**
 * Count Tokens Controller Tests
 *
 * Tests for the countTokensController which handles the
 * POST /v1/messages/count_tokens endpoint.
 */
import { describe, beforeAll, beforeEach, it, expect, jest } from '@jest/globals';
import { NextFunction } from 'express';

// Mock logger
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn()
  })
}));

// Import after mocks are set up
import * as countTokensController from '../src/controllers/countTokensController';
import tokenCountService from '../src/services/tokenCountService';
import configService from '../src/services/configService';

// Type for token count response
interface CountTokensResponse {
  input_tokens: number;
}

describe('CountTokensController', () => {
  // Wait for encodings to pre-load
  beforeAll(async () => {
    await tokenCountService.waitForPreload();
  }, 30000);

  // Mock request, response, and next - using 'any' to avoid complex Express type assertions
  let mockReq: any;
  let mockRes: any;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    mockRes = {
      json: jsonMock,
      status: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
  });

  describe('handleCountTokens', () => {
    describe('successful token counting', () => {
      it('should return token count for a simple message', async () => {
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            messages: [
              { role: 'user', content: 'Hello, world!' },
            ],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        expect(jsonMock).toHaveBeenCalledTimes(1);
        const result = jsonMock.mock.calls[0][0] as CountTokensResponse;
        expect(result).toHaveProperty('input_tokens');
        expect(typeof result.input_tokens).toBe('number');
        expect(result.input_tokens).toBeGreaterThan(0);
      });

      it('should apply Claude multiplier (1.15x)', async () => {
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            messages: [
              { role: 'user', content: 'Test message for multiplier check' },
            ],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        const result = jsonMock.mock.calls[0][0] as CountTokensResponse;
        // The result should be multiplied by 1.15 and rounded
        expect(result.input_tokens).toBeGreaterThan(0);
      });

      it('should apply Grok multiplier (1.03x)', async () => {
        mockReq = {
          body: {
            model: 'grok-beta',
            max_tokens: 1024,
            messages: [
              { role: 'user', content: 'Test message' },
            ],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        const result = jsonMock.mock.calls[0][0] as CountTokensResponse;
        expect(result.input_tokens).toBeGreaterThan(0);
      });

      it('should handle anthropic deployed models', async () => {
        mockReq = {
          body: {
            model: 'anthropic--claude-3-sonnet--deployed',
            max_tokens: 1024,
            messages: [
              { role: 'user', content: 'Hello!' },
            ],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        const result = jsonMock.mock.calls[0][0] as CountTokensResponse;
        expect(result.input_tokens).toBeGreaterThan(0);
      });
    });

    describe('tool overhead', () => {
      it('should add 346 token overhead for Claude with tools', async () => {
        // Request without tools
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'Get weather' }],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );
        const resultWithoutTools = (jsonMock.mock.calls[0][0] as CountTokensResponse).input_tokens;

        // Reset mock
        jsonMock.mockClear();

        // Request with tools
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'Get weather' }],
            tools: [
              {
                name: 'get_weather',
                description: 'Get weather',
                input_schema: { type: 'object', properties: {} },
              },
            ],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );
        const resultWithTools = (jsonMock.mock.calls[0][0] as CountTokensResponse).input_tokens;

        // With tools should be higher (346 overhead + tool definition tokens)
        expect(resultWithTools).toBeGreaterThan(resultWithoutTools);
      });

      it('should add 480 token overhead for Grok with tools', async () => {
        mockReq = {
          body: {
            model: 'grok-beta',
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'Test' }],
            tools: [
              {
                name: 'test_tool',
                description: 'Test',
                input_schema: { type: 'object', properties: {} },
              },
            ],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        const result = jsonMock.mock.calls[0][0] as CountTokensResponse;
        expect(result.input_tokens).toBeGreaterThan(0);
      });

      it('should NOT add tool overhead for MCP tools with claude-code beta header', async () => {
        // With MCP tools and claude-code header
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'Test' }],
            tools: [
              {
                name: 'mcp__filesystem__read_file',
                description: 'Read a file',
                input_schema: { type: 'object', properties: {} },
              },
            ],
          },
          header: jest.fn<(name: string) => string | undefined>().mockImplementation((name: string) => {
            if (name === 'anthropic-beta') return 'claude-code-2024';
            return undefined;
          }),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        const resultMCP = (jsonMock.mock.calls[0][0] as CountTokensResponse).input_tokens;

        // Reset mock
        jsonMock.mockClear();

        // Without MCP prefix (should add overhead)
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'Test' }],
            tools: [
              {
                name: 'read_file',
                description: 'Read a file',
                input_schema: { type: 'object', properties: {} },
              },
            ],
          },
          header: jest.fn<(name: string) => string | undefined>().mockImplementation((name: string) => {
            if (name === 'anthropic-beta') return 'claude-code-2024';
            return undefined;
          }),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        const resultNonMCP = (jsonMock.mock.calls[0][0] as CountTokensResponse).input_tokens;

        // Non-MCP tools should have 346 overhead added
        expect(resultNonMCP).toBeGreaterThan(resultMCP);
      });
    });

    describe('error handling', () => {
      it('should return { input_tokens: 1 } when model is missing', async () => {
        mockReq = {
          body: {
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'Hello!' }],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        expect(jsonMock).toHaveBeenCalledWith({ input_tokens: 1 });
      });

      it('should return { input_tokens: 1 } when messages is missing', async () => {
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        expect(jsonMock).toHaveBeenCalledWith({ input_tokens: 1 });
      });

      it('should return { input_tokens: 1 } when messages is not an array', async () => {
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            messages: 'not an array',
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        expect(jsonMock).toHaveBeenCalledWith({ input_tokens: 1 });
      });
    });

    describe('complex payloads', () => {
      it('should handle messages with system prompt', async () => {
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            system: 'You are a helpful assistant.',
            messages: [
              { role: 'user', content: 'Hello!' },
            ],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        const result = jsonMock.mock.calls[0][0] as CountTokensResponse;
        expect(result.input_tokens).toBeGreaterThan(0);
      });

      it('should handle messages with array content', async () => {
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'What is this?' },
                ],
              },
            ],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        const result = jsonMock.mock.calls[0][0] as CountTokensResponse;
        expect(result.input_tokens).toBeGreaterThan(0);
      });

      it('should handle tool_use and tool_result in conversation', async () => {
        mockReq = {
          body: {
            model: 'claude-3-sonnet',
            max_tokens: 1024,
            messages: [
              { role: 'user', content: 'Get weather in Paris' },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_123',
                    name: 'get_weather',
                    input: { location: 'Paris' },
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_123',
                    content: '{"temp": 20}',
                  },
                ],
              },
            ],
            tools: [
              {
                name: 'get_weather',
                description: 'Get weather',
                input_schema: { type: 'object', properties: {} },
              },
            ],
          },
          header: jest.fn().mockReturnValue(undefined),
        };

        await countTokensController.handleCountTokens(
          mockReq as any,
          mockRes,
          mockNext
        );

        const result = jsonMock.mock.calls[0][0] as CountTokensResponse;
        expect(result.input_tokens).toBeGreaterThan(0);
      });
    });
  });

  /**
   * Model Substitution Tests
   * Verify that count_tokens applies model substitution consistently with /messages endpoint
   */
  describe('Model Substitution', () => {
    it('should apply model substitution when configured', async () => {
      // Mock configService to return substituted model
      const getSubstitutedModelSpy = jest.spyOn(configService, 'getSubstitutedModel')
        .mockReturnValue('anthropic--claude-4.5-haiku--deployed');

      // Mock tokenCountService to verify it receives the substituted model
      const getTokenCountSpy = jest.spyOn(tokenCountService, 'getTokenCount')
        .mockResolvedValue({ input: 100, output: 50 });

      mockReq = {
        body: {
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'Hello' }],
        },
        header: jest.fn().mockReturnValue(undefined),
      };

      await countTokensController.handleCountTokens(mockReq as any, mockRes, mockNext);

      // Verify substitution was called with correct parameters
      expect(getSubstitutedModelSpy).toHaveBeenCalledWith('anthropic', 'claude-haiku-4-5-20251001');

      // Verify tokenCountService received substituted model
      expect(getTokenCountSpy).toHaveBeenCalledWith(
        expect.any(Object),
        'anthropic--claude-4.5-haiku--deployed'
      );

      // Verify response was sent
      expect(jsonMock).toHaveBeenCalled();
      const result = jsonMock.mock.calls[0][0] as CountTokensResponse;
      expect(result.input_tokens).toBeGreaterThan(0);

      // Restore spies
      getSubstitutedModelSpy.mockRestore();
      getTokenCountSpy.mockRestore();
    });

    it('should use original model when no substitution configured', async () => {
      // Mock configService to return original model (no substitution)
      const getSubstitutedModelSpy = jest.spyOn(configService, 'getSubstitutedModel')
        .mockReturnValue('claude-3-5-sonnet-20240229');

      // Mock tokenCountService
      const getTokenCountSpy = jest.spyOn(tokenCountService, 'getTokenCount')
        .mockResolvedValue({ input: 120, output: 60 });

      mockReq = {
        body: {
          model: 'claude-3-5-sonnet-20240229',
          messages: [{ role: 'user', content: 'Hello' }],
        },
        header: jest.fn().mockReturnValue(undefined),
      };

      await countTokensController.handleCountTokens(mockReq as any, mockRes, mockNext);

      // Verify substitution was called
      expect(getSubstitutedModelSpy).toHaveBeenCalledWith('anthropic', 'claude-3-5-sonnet-20240229');

      // Verify tokenCountService received the original model (same as input)
      expect(getTokenCountSpy).toHaveBeenCalledWith(
        expect.any(Object),
        'claude-3-5-sonnet-20240229'
      );

      // Verify response was sent
      expect(jsonMock).toHaveBeenCalled();

      // Restore spies
      getSubstitutedModelSpy.mockRestore();
      getTokenCountSpy.mockRestore();
    });

    it('should use substituted model for tool overhead calculations', async () => {
      // Mock configService to substitute to deployed model
      const getSubstitutedModelSpy = jest.spyOn(configService, 'getSubstitutedModel')
        .mockReturnValue('anthropic--claude-4.5-haiku--deployed');

      // Mock tokenCountService
      const getTokenCountSpy = jest.spyOn(tokenCountService, 'getTokenCount')
        .mockResolvedValue({ input: 100, output: 50 });

      mockReq = {
        body: {
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'Hello' }],
          tools: [
            {
              name: 'get_weather',
              description: 'Get weather information',
              input_schema: { type: 'object', properties: {} },
            },
          ],
        },
        header: jest.fn().mockReturnValue(undefined),
      };

      await countTokensController.handleCountTokens(mockReq as any, mockRes, mockNext);

      // Verify substitution was called
      expect(getSubstitutedModelSpy).toHaveBeenCalledWith('anthropic', 'claude-haiku-4-5-20251001');

      // Get the result
      const result = jsonMock.mock.calls[0][0] as CountTokensResponse;

      // Should have tool overhead (+346) and multiplier (x1.15) applied
      // because substituted model starts with 'anthropic--'
      // Base: 100 + 50 = 150
      // With tool overhead: 150 + 346 = 496
      // With multiplier: 496 * 1.15 = 570 (rounded)
      expect(result.input_tokens).toBe(570);

      // Restore spies
      getSubstitutedModelSpy.mockRestore();
      getTokenCountSpy.mockRestore();
    });

    it('should use substituted model for model-specific multipliers', async () => {
      // Mock configService to substitute to deployed model
      const getSubstitutedModelSpy = jest.spyOn(configService, 'getSubstitutedModel')
        .mockReturnValue('anthropic--claude-4.5-haiku--deployed');

      // Mock tokenCountService
      const getTokenCountSpy = jest.spyOn(tokenCountService, 'getTokenCount')
        .mockResolvedValue({ input: 100, output: 50 });

      mockReq = {
        body: {
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'Hello' }],
          // No tools, so only multiplier applies
        },
        header: jest.fn().mockReturnValue(undefined),
      };

      await countTokensController.handleCountTokens(mockReq as any, mockRes, mockNext);

      // Get the result
      const result = jsonMock.mock.calls[0][0] as CountTokensResponse;

      // Should have multiplier (x1.15) applied because substituted model starts with 'anthropic--'
      // Base: 100 + 50 = 150
      // With multiplier: 150 * 1.15 = 172.5 → 173 (rounded)
      expect(result.input_tokens).toBe(173);

      // Restore spies
      getSubstitutedModelSpy.mockRestore();
      getTokenCountSpy.mockRestore();
    });
  });
});
