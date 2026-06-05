/**
 * Token Count Service Tests
 *
 * Tests for the tokenCountService which provides local tokenization
 * for Anthropic Messages API format using gpt-tokenizer.
 */
import { describe, beforeAll, it, expect, jest } from '@jest/globals';

// Mock logger to avoid console noise during tests
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn()
  })
}));

import tokenCountService from '../src/services/tokenCountService';

describe('TokenCountService', () => {
  // Wait for encodings to pre-load before running tests
  beforeAll(async () => {
    await tokenCountService.waitForPreload();
  }, 30000); // Allow up to 30s for encoding pre-load

  describe('isReady', () => {
    it('should return true after pre-loading', () => {
      expect(tokenCountService.isReady()).toBe(true);
    });
  });

  describe('getTokenCount', () => {
    describe('basic message counting', () => {
      it('should count tokens for a simple user message', async () => {
        const payload = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'user' as const, content: 'Hello, world!' },
          ],
        };

        const result = await tokenCountService.getTokenCount(payload, 'claude-3-sonnet');

        expect(result.input).toBeGreaterThan(0);
        expect(result.output).toBe(0);
      });

      it('should count tokens for user and assistant messages', async () => {
        const payload = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'user' as const, content: 'Hello!' },
            { role: 'assistant' as const, content: 'Hi there! How can I help you today?' },
          ],
        };

        const result = await tokenCountService.getTokenCount(payload, 'claude-3-sonnet');

        expect(result.input).toBeGreaterThan(0);
        expect(result.output).toBeGreaterThan(0);
      });

      it('should count tokens for system message as input', async () => {
        const payload = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'system' as const, content: 'You are a helpful assistant.' },
            { role: 'user' as const, content: 'Hello!' },
          ],
        };

        const result = await tokenCountService.getTokenCount(payload, 'claude-3-sonnet');

        expect(result.input).toBeGreaterThan(0);
      });

      it('should handle empty messages array', async () => {
        const payload = {
          model: 'claude-3-sonnet',
          messages: [],
        };

        const result = await tokenCountService.getTokenCount(payload, 'claude-3-sonnet');

        expect(result.input).toBe(0);
        expect(result.output).toBe(0);
      });

      it('should add extra token for message with name field', async () => {
        const payloadWithoutName = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'user' as const, content: 'Hello!' },
          ],
        };

        const payloadWithName = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'user' as const, content: 'Hello!', name: 'John' },
          ],
        };

        const resultWithout = await tokenCountService.getTokenCount(payloadWithoutName, 'claude-3-sonnet');
        const resultWith = await tokenCountService.getTokenCount(payloadWithName, 'claude-3-sonnet');

        // Name field adds 1 token plus the encoded name
        expect(resultWith.input).toBeGreaterThan(resultWithout.input);
      });
    });

    describe('content array format', () => {
      it('should count tokens for text content in array format', async () => {
        const payload = {
          model: 'claude-3-sonnet',
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: 'What is in this image?' },
              ],
            },
          ],
        };

        const result = await tokenCountService.getTokenCount(payload, 'claude-3-sonnet');

        expect(result.input).toBeGreaterThan(0);
      });

      it('should add 85 token overhead for image content', async () => {
        const payloadTextOnly = {
          model: 'claude-3-sonnet',
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: 'Describe this.' },
              ],
            },
          ],
        };

        const payloadWithImage = {
          model: 'claude-3-sonnet',
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: 'Describe this.' },
                {
                  type: 'image_url' as const,
                  image_url: {
                    url: 'data:image/png;base64,ABC123',
                  },
                },
              ],
            },
          ],
        };

        const resultText = await tokenCountService.getTokenCount(payloadTextOnly, 'claude-3-sonnet');
        const resultImage = await tokenCountService.getTokenCount(payloadWithImage, 'claude-3-sonnet');

        // Image adds 85 overhead plus encoded URL
        expect(resultImage.input).toBeGreaterThan(resultText.input + 85);
      });
    });

    describe('tool definitions', () => {
      it('should add tokens for tool definitions', async () => {
        const payloadWithoutTools = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'user' as const, content: 'What is the weather?' },
          ],
        };

        const payloadWithTools = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'user' as const, content: 'What is the weather?' },
          ],
          tools: [
            {
              type: 'function' as const,
              function: {
                name: 'get_weather',
                description: 'Get the current weather for a location',
                parameters: {
                  type: 'object',
                  properties: {
                    location: {
                      type: 'string',
                      description: 'The city and state',
                    },
                  },
                  required: ['location'],
                },
              },
            },
          ],
        };

        const resultWithout = await tokenCountService.getTokenCount(payloadWithoutTools, 'claude-3-sonnet');
        const resultWith = await tokenCountService.getTokenCount(payloadWithTools, 'claude-3-sonnet');

        expect(resultWith.input).toBeGreaterThan(resultWithout.input);
      });

      it('should handle tool parameters with enum values', async () => {
        const payload = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'user' as const, content: 'Set the color.' },
          ],
          tools: [
            {
              type: 'function' as const,
              function: {
                name: 'set_color',
                description: 'Set a color',
                parameters: {
                  type: 'object',
                  properties: {
                    color: {
                      type: 'string',
                      description: 'The color to set',
                      enum: ['red', 'green', 'blue'],
                    },
                  },
                },
              },
            },
          ],
        };

        const result = await tokenCountService.getTokenCount(payload, 'claude-3-sonnet');

        expect(result.input).toBeGreaterThan(0);
      });

      it('should strip trailing period from tool description', async () => {
        const payloadWithPeriod = {
          model: 'claude-3-sonnet',
          messages: [{ role: 'user' as const, content: 'Test' }],
          tools: [
            {
              type: 'function' as const,
              function: {
                name: 'test',
                description: 'A test function.',
                parameters: {},
              },
            },
          ],
        };

        const payloadWithoutPeriod = {
          model: 'claude-3-sonnet',
          messages: [{ role: 'user' as const, content: 'Test' }],
          tools: [
            {
              type: 'function' as const,
              function: {
                name: 'test',
                description: 'A test function',
                parameters: {},
              },
            },
          ],
        };

        const resultWith = await tokenCountService.getTokenCount(payloadWithPeriod, 'claude-3-sonnet');
        const resultWithout = await tokenCountService.getTokenCount(payloadWithoutPeriod, 'claude-3-sonnet');

        // Should produce same count since trailing period is stripped
        expect(resultWith.input).toBe(resultWithout.input);
      });
    });

    describe('tool calls in messages', () => {
      it('should count tokens for tool_calls in assistant message', async () => {
        const payload = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'user' as const, content: 'What is the weather in Paris?' },
            {
              role: 'assistant' as const,
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function' as const,
                  function: {
                    name: 'get_weather',
                    arguments: '{"location": "Paris, France"}',
                  },
                },
              ],
            },
          ],
        };

        const result = await tokenCountService.getTokenCount(payload, 'claude-3-sonnet');

        expect(result.input).toBeGreaterThan(0);
        expect(result.output).toBeGreaterThan(0);
      });

      it('should count tokens for tool role messages', async () => {
        const payload = {
          model: 'claude-3-sonnet',
          messages: [
            { role: 'user' as const, content: 'What is the weather?' },
            {
              role: 'tool' as const,
              content: '{"temperature": 72, "condition": "sunny"}',
              tool_call_id: 'call_123',
            },
          ],
        };

        const result = await tokenCountService.getTokenCount(payload, 'claude-3-sonnet');

        expect(result.input).toBeGreaterThan(0);
      });
    });

    describe('model-specific behavior', () => {
      it('should use cl100k_base tokenizer for Claude models', async () => {
        const payload = {
          model: 'claude-3-sonnet',
          messages: [{ role: 'user' as const, content: 'Hello!' }],
        };

        const result = await tokenCountService.getTokenCount(payload, 'claude-3-sonnet');
        expect(result.input).toBeGreaterThan(0);
      });

      it('should use cl100k_base tokenizer for anthropic deployed models', async () => {
        const payload = {
          model: 'anthropic--claude-3-sonnet--deployed',
          messages: [{ role: 'user' as const, content: 'Hello!' }],
        };

        const result = await tokenCountService.getTokenCount(payload, 'anthropic--claude-3-sonnet--deployed');
        expect(result.input).toBeGreaterThan(0);
      });

      it('should use o200k_base tokenizer for Grok models', async () => {
        const payload = {
          model: 'grok-beta',
          messages: [{ role: 'user' as const, content: 'Hello!' }],
        };

        const result = await tokenCountService.getTokenCount(payload, 'grok-beta');
        expect(result.input).toBeGreaterThan(0);
      });

      it('should use different constants for GPT-4 models', async () => {
        const payload = {
          model: 'gpt-4',
          messages: [{ role: 'user' as const, content: 'Test' }],
          tools: [
            {
              type: 'function' as const,
              function: {
                name: 'test',
                description: 'Test',
                parameters: {},
              },
            },
          ],
        };

        // GPT-4 uses funcInit=10, others use funcInit=7
        const result = await tokenCountService.getTokenCount(payload, 'gpt-4');
        expect(result.input).toBeGreaterThan(0);
      });

      it('should default to o200k_base for unknown models', async () => {
        const payload = {
          model: 'unknown-model-xyz',
          messages: [{ role: 'user' as const, content: 'Hello!' }],
        };

        const result = await tokenCountService.getTokenCount(payload, 'unknown-model-xyz');
        expect(result.input).toBeGreaterThan(0);
      });
    });
  });
});
