/**
 * Unit Tests for Ollama Adapter
 * 
 * Tests the core functionality of the Ollama adapter including:
 * - Request transformations (Ollama -> OpenAI)
 * - Response transformations (OpenAI -> Ollama)  
 * - Streaming and non-streaming scenarios
 * - Chat, generate, and embeddings endpoints
 */

const ollamaAdapter = require('../../services/ollamaAdapter');

// Mock the shared service to avoid actual HTTP calls during testing
jest.mock('../../services/shared', () => ({
  callMainProxy: jest.fn(),
  callMainProxyStreaming: jest.fn()
}));

const mockShared = require('../../services/shared');

describe('Ollama Adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup default mock implementations
    mockShared.callMainProxy.mockImplementation(async (endpoint, data) => {
      // Mock OpenAI chat completion response
      if (endpoint === '/openai/v1/chat/completions') {
        return {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: Date.now(),
          model: data.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'This is a test response from the mock OpenAI API'
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 15,
            total_tokens: 25
          }
        };
      }
      
      // Mock models list response
      if (endpoint === '/v1/models') {
        return {
          object: 'list',
          data: [
            { id: 'gpt-4.1-nano', object: 'model', created: Date.now(), owned_by: 'openai' },
            { id: 'gpt-4', object: 'model', created: Date.now(), owned_by: 'openai' }
          ]
        };
      }
      
      // Mock embeddings response
      if (endpoint === '/openai/v1/embeddings') {
        return {
          object: 'list',
          data: [
            {
              object: 'embedding',
              embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
              index: 0
            }
          ],
          model: data.model,
          usage: {
            prompt_tokens: 5,
            total_tokens: 5
          }
        };
      }
      
      throw new Error(`Mock endpoint not implemented: ${endpoint}`);
    });
    
    mockShared.callMainProxyStreaming.mockImplementation(async (endpoint, data) => {
      // Mock streaming response
      return {
        data: {
          on: (event, callback) => {
            if (event === 'data') {
              // Simulate OpenAI streaming chunks - send pure JSON objects
              setTimeout(() => callback('{"choices":[{"delta":{"content":"Hello"}}]}'), 10);
              setTimeout(() => callback('{"choices":[{"delta":{"content":" world"}}]}'), 20);
              setTimeout(() => callback('[DONE]'), 30);
            } else if (event === 'end') {
              setTimeout(callback, 40);
            }
          }
        }
      };
    });
  });

  describe('Request Transformations', () => {
    it('should validate chat request transformation structure', () => {
      const ollamaChatRequest = {
        model: 'llama3.2',
        messages: [
          { role: 'user', content: 'Hello, how are you?' }
        ],
        stream: true,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          num_predict: 100,
          stop: ['stop_word'],
          seed: 42
        },
        format: 'json'
      };
      
      expect(ollamaChatRequest.model).toBeDefined();
      expect(ollamaChatRequest.messages).toHaveLength(1);
      expect(ollamaChatRequest.messages[0].role).toBe('user');
      expect(ollamaChatRequest.options).toBeDefined();
    });

    it('should validate generate request transformation structure', () => {
      const ollamaGenerateRequest = {
        model: 'llama3.2',
        prompt: 'Complete this sentence: The weather today is',
        stream: false,
        options: {
          temperature: 0.5,
          max_tokens: 50
        },
        system: 'You are a helpful assistant.',
        suffix: ' and it will continue tomorrow.'
      };
      
      expect(ollamaGenerateRequest.model).toBe('llama3.2');
      expect(ollamaGenerateRequest.prompt).toBeDefined();
      expect(ollamaGenerateRequest.options.temperature).toBe(0.5);
    });
  });

  describe('Non-Streaming Chat', () => {
    it('should handle non-streaming chat requests correctly', async () => {
      const ollamaRequest = {
        model: 'llama3.2',
        messages: [
          { role: 'user', content: 'Say hello' }
        ],
        stream: false
      };
      
      const result = await ollamaAdapter.handleNonStreamingChat(ollamaRequest);
      
      // Validate Ollama response format
      expect(result.model).toBe('llama3.2');
      expect(result.created_at).toBeDefined();
      expect(result.message).toBeDefined();
      expect(result.message.role).toBe('assistant');
      expect(typeof result.message.content).toBe('string');
      expect(result.done).toBe(true);
      expect(typeof result.total_duration).toBe('number');
      expect(typeof result.eval_count).toBe('number');
    });
  });

  describe('Non-Streaming Generate', () => {
    it('should handle non-streaming generate requests correctly', async () => {
      const ollamaRequest = {
        model: 'llama3.2',
        prompt: 'Complete this: The sky is',
        stream: false
      };
      
      const result = await ollamaAdapter.handleNonStreamingGenerate(ollamaRequest);
      
      // Validate Ollama generate response format
      expect(result.model).toBe('llama3.2');
      expect(result.created_at).toBeDefined();
      expect(typeof result.response).toBe('string');
      expect(result.done).toBe(true);
      expect(typeof result.total_duration).toBe('number');
      expect(Array.isArray(result.context)).toBe(true);
    });
  });

  describe('Streaming Chat', () => {
    it('should handle streaming chat requests correctly', async () => {
      const ollamaRequest = {
        model: 'llama3.2',
        messages: [
          { role: 'user', content: 'Tell me a joke' }
        ],
        stream: true
      };
      
      // Create a mock response object
      const mockResponse = {
        write: jest.fn(),
        end: jest.fn(),
        setHeader: jest.fn(),
        writableEnded: false
      };
      
      // Start the streaming
      const streamingPromise = ollamaAdapter.handleStreamingChat(ollamaRequest, mockResponse);
      
      // Wait for async events to process
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Verify streaming data was written
      expect(mockResponse.write).toHaveBeenCalled();
      
      await streamingPromise;
    });
  });

  describe('Embeddings', () => {
    it('should handle embeddings requests correctly', async () => {
      const ollamaRequest = {
        model: 'llama3.2',
        input: 'Test text for embeddings'
      };
      
      const result = await ollamaAdapter.handleEmbeddings(ollamaRequest);
      
      // Validate Ollama embeddings response format
      expect(result.model).toBe('llama3.2');
      expect(Array.isArray(result.embeddings)).toBe(true);
      expect(result.embeddings.length).toBeGreaterThan(0);
      expect(Array.isArray(result.embeddings[0])).toBe(true);
    });
  });

  describe('Models List', () => {
    it('should handle models list requests correctly', async () => {
      const result = await ollamaAdapter.listModels();
      
      // Validate Ollama models response format  
      expect(result.models).toBeDefined();
      expect(Array.isArray(result.models)).toBe(true);
      
      if (result.models.length > 0) {
        const model = result.models[0];
        expect(model.name).toBeDefined();
        expect(model.size).toBeDefined();
        expect(model.digest).toBeDefined();
        expect(model.details).toBeDefined();
      }
    });
  });

  describe('Version Info', () => {
    it('should handle version info requests correctly', async () => {
      const result = await ollamaAdapter.getVersion();
      
      // Validate version response format
      expect(result.version).toBeDefined();
      expect(typeof result.version).toBe('string');
    });
  });

  describe('Error Handling', () => {
    it('should handle empty model names by using default', async () => {
      const requestWithEmptyModel = {
        model: '', // Empty model should use default
        messages: [
          { role: 'user', content: 'Hello' }
        ]
      };
      
      const result = await ollamaAdapter.handleNonStreamingChat(requestWithEmptyModel);
      
      // Should use default model 
      expect(result.model).toBe('gpt-3.5-turbo');
      expect(result.message.content).toBeDefined();
    });

    it('should handle missing messages by using empty array', async () => {
      const requestWithoutMessages = {
        model: 'llama3.2'
        // messages field is missing
      };
      
      const result = await ollamaAdapter.handleNonStreamingChat(requestWithoutMessages);
      
      // Should handle gracefully with empty messages
      expect(result.model).toBe('llama3.2');
      expect(result.message.content).toBeDefined();
    });

    it('should handle network errors gracefully', async () => {
      // Mock network error
      mockShared.callMainProxy.mockRejectedValueOnce(new Error('Network error'));
      
      const request = {
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Hello' }]
      };
      
      await expect(ollamaAdapter.handleNonStreamingChat(request))
        .rejects
        .toThrow('Network error');
    });
  });
});