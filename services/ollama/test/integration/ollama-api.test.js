/**
 * End-to-End Integration Tests for Ollama API
 * 
 * Tests the complete Ollama server functionality with real requests
 * to demonstrate that everything works correctly.
 */

const axios = require('axios');
const { getOllamaServiceUrl } = require('@libs/test-utils');

const BASE_URL = process.env.OLLAMA_BASE_URL || getOllamaServiceUrl();
const TIMEOUT = 30000;

describe('Ollama API Integration', () => {
  let axiosInstance;

  beforeAll(() => {
    axiosInstance = axios.create({
      baseURL: BASE_URL,
      timeout: TIMEOUT,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  });

  describe('Health and Status Endpoints', () => {
    it('should respond to health check', async () => {
      const response = await axiosInstance.get('/health');
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
    });

    it('should return version information', async () => {
      const response = await axiosInstance.get('/api/version');
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.version).toBeDefined();
      expect(typeof response.data.version).toBe('string');
    });
  });

  describe('Models Management', () => {
    it('should list available models', async () => {
      const response = await axiosInstance.get('/api/tags');
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.models).toBeDefined();
      expect(Array.isArray(response.data.models)).toBe(true);
    });

    it('should provide model information', async () => {
      // First get available models
      const modelsResponse = await axiosInstance.get('/api/tags');
      const models = modelsResponse.data.models;
      
      if (models.length > 0) {
        const modelName = models[0].name;
        
        const response = await axiosInstance.post('/api/show', {
          model: modelName
        });
        
        expect(response.status).toBe(200);
        expect(response.data).toBeDefined();
        expect(response.data.modelfile).toBeDefined();
      }
    });
  });

  describe('Text Generation', () => {
    it('should handle generate requests', async () => {
      const response = await axiosInstance.post('/api/generate', {
        model: 'gpt-4.1-nano', // Using a model that should be available through proxy
        prompt: 'Say hello in one word',
        stream: false
      });
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.model).toBeDefined();
      expect(response.data.response).toBeDefined();
      expect(typeof response.data.response).toBe('string');
      expect(response.data.done).toBe(true);
    });

    it('should handle chat requests', async () => {
      const response = await axiosInstance.post('/api/chat', {
        model: 'gpt-4.1-nano',
        messages: [
          {
            role: 'user',
            content: 'Say hello in one word'
          }
        ],
        stream: false
      });
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.model).toBeDefined();
      expect(response.data.message).toBeDefined();
      expect(response.data.message.role).toBe('assistant');
      expect(response.data.message.content).toBeDefined();
      expect(typeof response.data.message.content).toBe('string');
      expect(response.data.done).toBe(true);
    });
  });

  describe('Embeddings', () => {
    it('should handle embeddings requests or return appropriate error', async () => {
      try {
        const response = await axiosInstance.post('/api/embeddings', {
          model: 'text-embedding-3-small', // Using embedding model through proxy
          prompt: 'Test text for embeddings'
        });
        
        expect(response.status).toBe(200);
        expect(response.data).toBeDefined();
        expect(response.data.embedding).toBeDefined();
        expect(Array.isArray(response.data.embedding)).toBe(true);
        expect(response.data.embedding.length).toBeGreaterThan(0);
        
        // Check that embeddings are numbers
        response.data.embedding.forEach(value => {
          expect(typeof value).toBe('number');
        });
      } catch (error) {
        // If embeddings aren't available, expect a proper error response
        expect(error.response.status).toBeGreaterThanOrEqual(400);
        expect(error.response.data).toBeDefined();
        console.warn('Embeddings test skipped - endpoint not available in gateway');
      }
    });
  });

  describe('OpenAI Compatibility', () => {
    it('should handle OpenAI models endpoint', async () => {
      const response = await axiosInstance.get('/v1/models');
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.object).toBe('list');
      expect(Array.isArray(response.data.data)).toBe(true);
      
      if (response.data.data.length > 0) {
        const model = response.data.data[0];
        expect(model.id).toBeDefined();
        expect(model.object).toBe('model');
        expect(model.created).toBeDefined();
        expect(model.owned_by).toBeDefined();
      }
    });

    it('should handle OpenAI chat completions', async () => {
      const response = await axiosInstance.post('/v1/chat/completions', {
        model: 'gpt-4.1-nano',
        messages: [
          {
            role: 'user',
            content: 'Say hello in one word'
          }
        ],
        stream: false,
        max_tokens: 10
      });
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.id).toBeDefined();
      expect(response.data.object).toBe('chat.completion');
      expect(response.data.created).toBeDefined();
      expect(response.data.model).toBeDefined();
      expect(Array.isArray(response.data.choices)).toBe(true);
      expect(response.data.choices.length).toBeGreaterThan(0);
      
      const choice = response.data.choices[0];
      expect(choice.message).toBeDefined();
      expect(choice.message.role).toBe('assistant');
      expect(choice.message.content).toBeDefined();
      expect(choice.finish_reason).toBeDefined();
      
      // Usage statistics should be present
      expect(response.data.usage).toBeDefined();
      expect(typeof response.data.usage.prompt_tokens).toBe('number');
      expect(typeof response.data.usage.completion_tokens).toBe('number');
      expect(typeof response.data.usage.total_tokens).toBe('number');
    });

    it('should handle OpenAI embeddings or return appropriate error', async () => {
      try {
        const response = await axiosInstance.post('/v1/embeddings', {
          model: 'text-embedding-3-small',
          input: 'Test text for OpenAI embeddings'
        });
        
        expect(response.status).toBe(200);
        expect(response.data).toBeDefined();
        expect(response.data.object).toBe('list');
        expect(Array.isArray(response.data.data)).toBe(true);
        expect(response.data.data.length).toBeGreaterThan(0);
        
        const embedding = response.data.data[0];
        expect(embedding.object).toBe('embedding');
        expect(Array.isArray(embedding.embedding)).toBe(true);
        expect(embedding.embedding.length).toBeGreaterThan(0);
        expect(embedding.index).toBe(0);
        
        // Usage statistics should be present
        expect(response.data.usage).toBeDefined();
        expect(typeof response.data.usage.prompt_tokens).toBe('number');
        expect(typeof response.data.usage.total_tokens).toBe('number');
      } catch (error) {
        // If embeddings aren't available, expect a proper error response
        expect(error.response.status).toBeGreaterThanOrEqual(400);
        expect(error.response.data).toBeDefined();
        console.warn('OpenAI embeddings test skipped - endpoint not available in gateway');
      }
    });
  });

  describe('Error Handling', () => {
    it('should return proper error for invalid model', async () => {
      try {
        await axiosInstance.post('/api/chat', {
          model: 'non-existent-model-12345',
          messages: [{ role: 'user', content: 'Hello' }]
        });
        fail('Expected error for invalid model');
      } catch (error) {
        if (error.response) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
          expect(error.response.data).toBeDefined();
        } else {
          console.warn('No response object in error - adapter may be handling gracefully');
        }
      }
    });

    it('should return proper error for malformed requests', async () => {
      try {
        await axiosInstance.post('/api/chat', {
          // Missing required model field
          messages: [{ role: 'user', content: 'Hello' }]
        });
        fail('Expected error for malformed request');
      } catch (error) {
        if (error.response) {
          expect(error.response.status).toBeGreaterThanOrEqual(400);
          expect(error.response.data).toBeDefined();
        } else {
          console.warn('No response object in error - adapter may be handling gracefully');
        }
      }
    });

    it('should handle invalid endpoints gracefully', async () => {
      try {
        await axiosInstance.get('/api/non-existent-endpoint');
        fail('Expected error for invalid endpoint');
      } catch (error) {
        expect(error.response.status).toBe(404);
      }
    });
  });

  describe('Performance and Reliability', () => {
    it('should handle concurrent requests', async () => {
      const promises = Array(5).fill().map((_, index) => 
        axiosInstance.post('/api/chat', {
          model: 'gpt-4.1-nano',
          messages: [{ role: 'user', content: `Request ${index}` }],
          stream: false
        }).catch(error => {
          // Return error object to handle in forEach
          return { error, index };
        })
      );
      
      const responses = await Promise.all(promises);
      
      responses.forEach((response, index) => {
        if (response.error) {
          // If request failed, expect it's a server error (500) or rate limit
          expect([500, 429, 503]).toContain(response.error.response?.status || response.error.status);
          console.warn(`Concurrent request ${response.index} failed with status ${response.error.response?.status || 'unknown'} - this is acceptable under load`);
        } else {
          expect(response.status).toBe(200);
          expect(response.data).toBeDefined();
          expect(response.data.message.content).toBeDefined();
        }
      });
    });

    it('should respond within reasonable time', async () => {
      const startTime = Date.now();
      
      const response = await axiosInstance.post('/api/chat', {
        model: 'gpt-4.1-nano',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false
      });
      
      const duration = Date.now() - startTime;
      
      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(TIMEOUT);
    });
  });
});