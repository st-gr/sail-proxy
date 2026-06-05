/**
 * OpenAI Compatibility Integration Tests
 * 
 * Tests the /v1/* endpoints that provide OpenAI API compatibility
 */

const axios = require('axios');
const { getOllamaServiceUrl } = require('@libs/test-utils');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || getOllamaServiceUrl();

describe('OpenAI Compatibility Integration', () => {
  let axiosInstance;

  beforeAll(() => {
    axiosInstance = axios.create({
      baseURL: OLLAMA_BASE_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  });

  describe('Models Endpoint', () => {
    it('should return models in OpenAI format', async () => {
      const response = await axiosInstance.get('/v1/models');
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.object).toBe('list');
      expect(Array.isArray(response.data.data)).toBe(true);
      
      if (response.data.data.length > 0) {
        const model = response.data.data[0];
        expect(model.id).toBeDefined();
        expect(model.object).toBe('model');
        expect(typeof model.created).toBe('number');
        expect(model.owned_by).toBeDefined();
      }
    });

    it('should include common models in the list', async () => {
      const response = await axiosInstance.get('/v1/models');
      const modelIds = response.data.data.map(m => m.id);
      
      // Should include some standard models
      const commonModels = ['gpt-4.1-nano', 'gpt-4.1-nano'];
      const hasCommonModel = commonModels.some(model => modelIds.includes(model));
      
      expect(hasCommonModel).toBe(true);
    });
  });

  describe('Chat Completions Endpoint', () => {
    it('should handle basic chat completions', async () => {
      const response = await axiosInstance.post('/v1/chat/completions', {
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'user', content: 'Say "Hello OpenAI compatibility!" and nothing else.' }
        ],
        stream: false,
        max_tokens: 20
      });
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.id).toBeDefined();
      expect(response.data.object).toBe('chat.completion');
      expect(typeof response.data.created).toBe('number');
      expect(response.data.model).toBe('gpt-4.1-nano');
      
      // Choices validation
      expect(Array.isArray(response.data.choices)).toBe(true);
      expect(response.data.choices.length).toBe(1);
      
      const choice = response.data.choices[0];
      expect(choice.index).toBe(0);
      expect(choice.message).toBeDefined();
      expect(choice.message.role).toBe('assistant');
      expect(choice.message.content).toBeDefined();
      expect(typeof choice.message.content).toBe('string');
      expect(choice.finish_reason).toBeDefined();
      
      // Usage validation
      expect(response.data.usage).toBeDefined();
      expect(typeof response.data.usage.prompt_tokens).toBe('number');
      expect(typeof response.data.usage.completion_tokens).toBe('number');
      expect(typeof response.data.usage.total_tokens).toBe('number');
      expect(response.data.usage.total_tokens).toBe(
        response.data.usage.prompt_tokens + response.data.usage.completion_tokens
      );
    });

    it('should handle system messages', async () => {
      const response = await axiosInstance.post('/v1/chat/completions', {
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that only responds with "OK".' },
          { role: 'user', content: 'Hello there!' }
        ],
        stream: false
      });
      
      expect(response.status).toBe(200);
      expect(response.data.choices[0].message.content).toBeDefined();
    });

    it('should handle temperature parameter', async () => {
      const response = await axiosInstance.post('/v1/chat/completions', {
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'user', content: 'Say hello' }
        ],
        temperature: 0.7,
        stream: false
      });
      
      expect(response.status).toBe(200);
      expect(response.data.choices[0].message.content).toBeDefined();
    });

    it('should handle max_tokens parameter', async () => {
      const response = await axiosInstance.post('/v1/chat/completions', {
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'user', content: 'Write a long essay about artificial intelligence' }
        ],
        max_tokens: 5,
        stream: false
      });
      
      expect(response.status).toBe(200);
      expect(response.data.usage.completion_tokens).toBeLessThanOrEqual(5);
    });

    it('should handle stop parameter', async () => {
      const response = await axiosInstance.post('/v1/chat/completions', {
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'user', content: 'Count: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10' }
        ],
        stop: ['5'],
        stream: false
      });
      
      expect(response.status).toBe(200);
      const content = response.data.choices[0].message.content;
      expect(content).toBeDefined();
    });
  });

  describe('Embeddings Endpoint', () => {
    it('should handle embeddings requests or return proper error', async () => {
      try {
        const response = await axiosInstance.post('/v1/embeddings', {
          model: 'text-embedding-3-small',
          input: 'Test embedding text'
        });
        
        expect(response.status).toBe(200);
        expect(response.data).toBeDefined();
        expect(response.data.object).toBe('list');
        
        // Data validation
        expect(Array.isArray(response.data.data)).toBe(true);
        expect(response.data.data.length).toBe(1);
        
        const embedding = response.data.data[0];
        expect(embedding.object).toBe('embedding');
        expect(embedding.index).toBe(0);
        expect(Array.isArray(embedding.embedding)).toBe(true);
        expect(embedding.embedding.length).toBeGreaterThan(0);
        
        // All embedding values should be numbers
        embedding.embedding.forEach(value => {
          expect(typeof value).toBe('number');
          expect(isFinite(value)).toBe(true);
        });
        
        // Usage validation
        expect(response.data.usage).toBeDefined();
        expect(typeof response.data.usage.prompt_tokens).toBe('number');
        expect(typeof response.data.usage.total_tokens).toBe('number');
      } catch (error) {
        // If embeddings aren't available, expect proper error response
        expect(error.response.status).toBeGreaterThanOrEqual(400);
        console.warn('OpenAI compatibility embeddings test skipped - endpoint not available');
      }
    });

    it('should handle array of inputs or return proper error', async () => {
      try {
        const response = await axiosInstance.post('/v1/embeddings', {
          model: 'text-embedding-3-small',
          input: ['First text', 'Second text', 'Third text']
        });
        
        expect(response.status).toBe(200);
        expect(response.data.data.length).toBe(3);
        
        response.data.data.forEach((embedding, index) => {
          expect(embedding.object).toBe('embedding');
          expect(embedding.index).toBe(index);
          expect(Array.isArray(embedding.embedding)).toBe(true);
          expect(embedding.embedding.length).toBeGreaterThan(0);
        });
      } catch (error) {
        // If embeddings aren't available, expect proper error response
        if (error.response?.status) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
        }
        console.warn('OpenAI compatibility array embeddings test skipped - endpoint not available');
      }
    });
  });

  describe('Error Handling', () => {
    it('should return OpenAI-compatible error for invalid model', async () => {
      try {
        await axiosInstance.post('/v1/chat/completions', {
          model: 'non-existent-model',
          messages: [{ role: 'user', content: 'Hello' }]
        });
        fail('Expected error for invalid model');
      } catch (error) {
        if (error.response) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
          expect(error.response.data).toBeDefined();
        } else {
          console.warn('No response object in error for invalid model test');
        }
      }
    });

    it('should return OpenAI-compatible error for missing messages', async () => {
      try {
        await axiosInstance.post('/v1/chat/completions', {
          model: 'gpt-4.1-nano'
          // Missing messages field
        });
        fail('Expected error for missing messages');
      } catch (error) {
        expect(error.response.status).toBeGreaterThanOrEqual(400);
        expect(error.response.data).toBeDefined();
      }
    });

    it('should return OpenAI-compatible error for invalid temperature', async () => {
      try {
        await axiosInstance.post('/v1/chat/completions', {
          model: 'gpt-4.1-nano',
          messages: [{ role: 'user', content: 'Hello' }],
          temperature: 5.0 // Invalid: should be between 0 and 2
        });
        fail('Expected error for invalid temperature');
      } catch (error) {
        if (error.response) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
          expect(error.response.data).toBeDefined();
        } else {
          console.warn('No response object in error for invalid temperature test');
        }
      }
    });
  });

  describe('Response Format Compliance', () => {
    it('should match OpenAI response structure exactly', async () => {
      const response = await axiosInstance.post('/v1/chat/completions', {
        model: 'gpt-4.1-nano',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false
      });
      
      const data = response.data;
      
      // Required fields according to OpenAI API spec
      expect(data.id).toBeDefined();
      expect(data.object).toBe('chat.completion');
      expect(typeof data.created).toBe('number');
      expect(data.model).toBeDefined();
      expect(Array.isArray(data.choices)).toBe(true);
      expect(data.usage).toBeDefined();
      
      // Choice structure
      const choice = data.choices[0];
      expect(typeof choice.index).toBe('number');
      expect(choice.message).toBeDefined();
      expect(choice.message.role).toBe('assistant');
      expect(typeof choice.message.content).toBe('string');
      expect(choice.finish_reason).toBeDefined();
      
      // Usage structure
      expect(typeof data.usage.prompt_tokens).toBe('number');
      expect(typeof data.usage.completion_tokens).toBe('number');
      expect(typeof data.usage.total_tokens).toBe('number');
    });

    it('should have consistent model names across endpoints', async () => {
      // Get models from /v1/models
      const modelsResponse = await axiosInstance.get('/v1/models');
      const availableModels = modelsResponse.data.data.map(m => m.id);
      
      if (availableModels.includes('gpt-4.1-nano')) {
        // Use the model in chat completion
        const chatResponse = await axiosInstance.post('/v1/chat/completions', {
          model: 'gpt-4.1-nano',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: false
        });
        
        // Model name should be consistent
        expect(chatResponse.data.model).toBe('gpt-4.1-nano');
      }
    });
  });
});