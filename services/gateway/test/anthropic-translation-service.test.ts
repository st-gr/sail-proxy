/**
 * Anthropic Translation Service Tests
 *
 * Tests for the anthropicTranslationService which converts Anthropic
 * Messages API format to OpenAI chat completions format.
 */
import { describe, it, expect } from '@jest/globals';
import anthropicTranslationService from '../src/services/anthropicTranslationService';

describe('AnthropicTranslationService', () => {
  describe('translateAnthropicToOpenAI', () => {
    describe('basic translation', () => {
      it('should translate a simple user message', () => {
        const anthropicPayload = {
          model: 'claude-3-sonnet-20240229',
          max_tokens: 1024,
          messages: [
            { role: 'user' as const, content: 'Hello!' },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(anthropicPayload);

        expect(result.model).toBe('claude-3-sonnet');
        expect(result.max_tokens).toBe(1024);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toEqual({
          role: 'user',
          content: 'Hello!',
        });
      });

      it('should translate user and assistant messages', () => {
        const anthropicPayload = {
          model: 'claude-3-sonnet',
          max_tokens: 1024,
          messages: [
            { role: 'user' as const, content: 'Hello!' },
            { role: 'assistant' as const, content: 'Hi there!' },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(anthropicPayload);

        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].role).toBe('user');
        expect(result.messages[1].role).toBe('assistant');
      });

      it('should preserve optional parameters', () => {
        const anthropicPayload = {
          model: 'claude-3-sonnet',
          max_tokens: 1024,
          messages: [{ role: 'user' as const, content: 'Hello!' }],
          temperature: 0.7,
          top_p: 0.9,
          stop_sequences: ['END'],
          stream: true,
          metadata: { user_id: 'user-123' },
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(anthropicPayload);

        expect(result.temperature).toBe(0.7);
        expect(result.top_p).toBe(0.9);
        expect(result.stop).toEqual(['END']);
        expect(result.stream).toBe(true);
        expect(result.user).toBe('user-123');
      });
    });

    describe('model name translation', () => {
      it('should strip version suffix from claude-3-sonnet', () => {
        const payload = {
          model: 'claude-3-sonnet-20240229',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);
        expect(result.model).toBe('claude-3-sonnet');
      });

      it('should strip version suffix from claude-sonnet-4', () => {
        const payload = {
          model: 'claude-sonnet-4-20241022',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);
        expect(result.model).toBe('claude-sonnet-4');
      });

      it('should strip version suffix from claude-opus-4', () => {
        const payload = {
          model: 'claude-opus-4-20241022',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);
        expect(result.model).toBe('claude-opus-4');
      });

      it('should strip version suffix from claude-3-5-sonnet', () => {
        const payload = {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);
        expect(result.model).toBe('claude-3-5-sonnet');
      });

      it('should preserve model name without version suffix', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);
        expect(result.model).toBe('claude-3-sonnet');
      });
    });

    describe('system prompt handling', () => {
      it('should translate string system prompt to system message', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          system: 'You are a helpful assistant.',
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.messages).toHaveLength(2);
        expect(result.messages[0]).toEqual({
          role: 'system',
          content: 'You are a helpful assistant.',
        });
      });

      it('should translate array system prompt to concatenated system message', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          system: [
            { type: 'text' as const, text: 'You are a helpful assistant.' },
            { type: 'text' as const, text: 'Be concise.' },
          ],
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.messages[0]).toEqual({
          role: 'system',
          content: 'You are a helpful assistant.\n\nBe concise.',
        });
      });

      it('should handle missing system prompt', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].role).toBe('user');
      });
    });

    describe('user message content handling', () => {
      it('should handle string content', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hello!' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.messages[0].content).toBe('Hello!');
      });

      it('should handle array content with text blocks', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: 'First part.' },
                { type: 'text' as const, text: 'Second part.' },
              ],
            },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.messages[0].content).toBe('First part.\n\nSecond part.');
      });

      it('should convert image blocks to OpenAI image_url format', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: 'What is this?' },
                {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: 'image/png' as const,
                    data: 'iVBORw0KGgo=',
                  },
                },
              ],
            },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(Array.isArray(result.messages[0].content)).toBe(true);
        const content = result.messages[0].content as any[];
        expect(content).toHaveLength(2);
        expect(content[0]).toEqual({ type: 'text', text: 'What is this?' });
        expect(content[1]).toEqual({
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
        });
      });

      it('should convert tool_result blocks to tool role messages', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [
            {
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result' as const,
                  tool_use_id: 'tool_123',
                  content: '{"result": "success"}',
                },
              ],
            },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toEqual({
          role: 'tool',
          tool_call_id: 'tool_123',
          content: '{"result": "success"}',
        });
      });

      it('should split user content with both tool_result and text', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [
            {
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result' as const,
                  tool_use_id: 'tool_123',
                  content: '{"result": "success"}',
                },
                { type: 'text' as const, text: 'Great, thanks!' },
              ],
            },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.messages).toHaveLength(2);
        expect(result.messages[0].role).toBe('tool');
        expect(result.messages[1].role).toBe('user');
        expect(result.messages[1].content).toBe('Great, thanks!');
      });
    });

    describe('assistant message content handling', () => {
      it('should handle string content', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [
            { role: 'user' as const, content: 'Hi' },
            { role: 'assistant' as const, content: 'Hello!' },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.messages[1].content).toBe('Hello!');
      });

      it('should convert tool_use blocks to tool_calls', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [
            { role: 'user' as const, content: 'Get weather' },
            {
              role: 'assistant' as const,
              content: [
                {
                  type: 'tool_use' as const,
                  id: 'call_123',
                  name: 'get_weather',
                  input: { location: 'Paris' },
                },
              ],
            },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        const assistantMsg = result.messages[1];
        expect(assistantMsg.tool_calls).toBeDefined();
        expect(assistantMsg.tool_calls).toHaveLength(1);
        expect(assistantMsg.tool_calls![0]).toEqual({
          id: 'call_123',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: '{"location":"Paris"}',
          },
        });
      });

      it('should handle mixed text and tool_use content', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [
            { role: 'user' as const, content: 'Get weather' },
            {
              role: 'assistant' as const,
              content: [
                { type: 'text' as const, text: 'Let me check the weather.' },
                {
                  type: 'tool_use' as const,
                  id: 'call_123',
                  name: 'get_weather',
                  input: { location: 'Paris' },
                },
              ],
            },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        const assistantMsg = result.messages[1];
        expect(assistantMsg.content).toBe('Let me check the weather.');
        expect(assistantMsg.tool_calls).toHaveLength(1);
      });

      it('should handle thinking blocks by concatenating with text', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [
            { role: 'user' as const, content: 'Solve this problem' },
            {
              role: 'assistant' as const,
              content: [
                { type: 'thinking' as const, thinking: 'Let me think about this...' },
                { type: 'text' as const, text: 'The answer is 42.' },
              ],
            },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        // Thinking and text are combined (text first, then thinking)
        expect(result.messages[1].content).toBe('Let me think about this...\n\nThe answer is 42.');
      });
    });

    describe('tool definitions translation', () => {
      it('should translate Anthropic tools to OpenAI function format', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
          tools: [
            {
              name: 'get_weather',
              description: 'Get the weather',
              input_schema: {
                type: 'object',
                properties: {
                  location: { type: 'string' },
                },
              },
            },
          ],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.tools).toBeDefined();
        expect(result.tools).toHaveLength(1);
        expect(result.tools![0]).toEqual({
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' },
              },
            },
          },
        });
      });

      it('should handle undefined tools', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.tools).toBeUndefined();
      });
    });

    describe('tool_choice translation', () => {
      it('should translate auto tool_choice', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
          tool_choice: { type: 'auto' as const },
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.tool_choice).toBe('auto');
      });

      it('should translate any tool_choice to required', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
          tool_choice: { type: 'any' as const },
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.tool_choice).toBe('required');
      });

      it('should translate none tool_choice', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
          tool_choice: { type: 'none' as const },
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.tool_choice).toBe('none');
      });

      it('should translate tool tool_choice with name', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
          tool_choice: { type: 'tool' as const, name: 'get_weather' },
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.tool_choice).toEqual({
          type: 'function',
          function: { name: 'get_weather' },
        });
      });

      it('should return undefined for tool tool_choice without name', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
          tool_choice: { type: 'tool' as const },
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.tool_choice).toBeUndefined();
      });

      it('should handle undefined tool_choice', () => {
        const payload = {
          model: 'claude-3-sonnet',
          max_tokens: 100,
          messages: [{ role: 'user' as const, content: 'Hi' }],
        };

        const result = anthropicTranslationService.translateAnthropicToOpenAI(payload);

        expect(result.tool_choice).toBeUndefined();
      });
    });
  });
});
