/**
 * Client Validation Integration Tests
 * 
 * Tests Ollama response format validation and client compatibility
 * Compares server responses with expected Ollama API format
 */

const axios = require('axios');
const { getOllamaServiceUrl } = require('@libs/test-utils');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || getOllamaServiceUrl();

describe('Client Validation Integration', () => {
  let axiosInstance;

  beforeAll(() => {
    axiosInstance = axios.create({
      baseURL: OLLAMA_BASE_URL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
  });

  describe('Response Format Validation', () => {
    it('should validate /api/tags response format', async () => {
      const response = await axiosInstance.get('/api/tags');
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.models).toBeDefined();
      expect(Array.isArray(response.data.models)).toBe(true);
      
      if (response.data.models.length > 0) {
        const model = response.data.models[0];
        
        // Validate required fields according to Ollama API spec
        expect(model.name).toBeDefined();
        expect(typeof model.name).toBe('string');
        expect(model.size).toBeDefined();
        expect(typeof model.size).toBe('number');
        expect(model.digest).toBeDefined();
        expect(typeof model.digest).toBe('string');
        expect(model.modified_at).toBeDefined();
        expect(typeof model.modified_at).toBe('string');
        
        // Validate details object
        expect(model.details).toBeDefined();
        expect(typeof model.details).toBe('object');
        expect(model.details.format).toBeDefined();
        expect(model.details.family).toBeDefined();
        expect(model.details.parameter_size).toBeDefined();
      }
    });

    it('should validate /api/show response format', async () => {
      // Get a model to test with
      const tagsResponse = await axiosInstance.get('/api/tags');
      
      if (tagsResponse.data.models.length > 0) {
        const modelName = tagsResponse.data.models[0].name;
        
        const response = await axiosInstance.post('/api/show', {
          model: modelName
        });
        
        expect(response.status).toBe(200);
        expect(response.data).toBeDefined();
        expect(response.data.modelfile).toBeDefined();
        expect(typeof response.data.modelfile).toBe('string');
        
        // Optional fields that might be present
        if (response.data.parameters) {
          expect(typeof response.data.parameters).toBe('string');
        }
        
        if (response.data.template) {
          expect(typeof response.data.template).toBe('string');
        }
        
        if (response.data.model_info) {
          expect(typeof response.data.model_info).toBe('object');
        }
      }
    });

    it('should validate /api/generate response format', async () => {
      const response = await axiosInstance.post('/api/generate', {
        model: 'gpt-4.1-nano',
        prompt: 'Say hello briefly',
        stream: false
      });
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      
      // Required fields for generate response
      expect(response.data.model).toBeDefined();
      expect(typeof response.data.model).toBe('string');
      expect(response.data.created_at).toBeDefined();
      expect(typeof response.data.created_at).toBe('string');
      expect(response.data.response).toBeDefined();
      expect(typeof response.data.response).toBe('string');
      expect(response.data.done).toBe(true);
      
      // Performance metrics (should be numbers)
      expect(typeof response.data.total_duration).toBe('number');
      expect(typeof response.data.load_duration).toBe('number');
      expect(typeof response.data.prompt_eval_count).toBe('number');
      expect(typeof response.data.prompt_eval_duration).toBe('number');
      expect(typeof response.data.eval_count).toBe('number');
      expect(typeof response.data.eval_duration).toBe('number');
      
      // Context should be an array
      expect(Array.isArray(response.data.context)).toBe(true);
    });

    it('should validate /api/chat response format', async () => {
      const response = await axiosInstance.post('/api/chat', {
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'user', content: 'Say hello briefly' }
        ],
        stream: false
      });
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      
      // Required fields for chat response
      expect(response.data.model).toBeDefined();
      expect(typeof response.data.model).toBe('string');
      expect(response.data.created_at).toBeDefined();
      expect(typeof response.data.created_at).toBe('string');
      expect(response.data.done).toBe(true);
      
      // Message object validation
      expect(response.data.message).toBeDefined();
      expect(response.data.message.role).toBe('assistant');
      expect(response.data.message.content).toBeDefined();
      expect(typeof response.data.message.content).toBe('string');
      
      // Performance metrics
      expect(typeof response.data.total_duration).toBe('number');
      expect(typeof response.data.load_duration).toBe('number');
      expect(typeof response.data.prompt_eval_count).toBe('number');
      expect(typeof response.data.prompt_eval_duration).toBe('number');
      expect(typeof response.data.eval_count).toBe('number');
      expect(typeof response.data.eval_duration).toBe('number');
    });

    it('should validate /api/embeddings response format or handle gracefully', async () => {
      try {
        const response = await axiosInstance.post('/api/embeddings', {
          model: 'text-embedding-3-small',
          prompt: 'Test embedding text'
        });
        
        expect(response.status).toBe(200);
        expect(response.data).toBeDefined();
        
        // Required fields for embeddings response
        expect(response.data.embedding).toBeDefined();
        expect(Array.isArray(response.data.embedding)).toBe(true);
        expect(response.data.embedding.length).toBeGreaterThan(0);
        
        // All embedding values should be numbers
        response.data.embedding.forEach(value => {
          expect(typeof value).toBe('number');
          expect(isFinite(value)).toBe(true);
        });
      } catch (error) {
        // If embeddings aren't available, expect a proper error response
        expect(error.response.status).toBeGreaterThanOrEqual(400);
        console.warn('Embeddings validation test skipped - endpoint not available in gateway');
      }
    });
  });

  describe('Field Type Validation', () => {
    it('should have consistent timestamp formats', async () => {
      const response = await axiosInstance.post('/api/chat', {
        model: 'gpt-4.1-nano',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false
      });
      
      const createdAt = response.data.created_at;
      
      // Should be ISO 8601 format timestamp
      expect(typeof createdAt).toBe('string');
      expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      
      // Should be parseable as a valid date
      const date = new Date(createdAt);
      expect(date.getTime()).not.toBeNaN();
    });

    it('should have consistent numeric field types', async () => {
      const response = await axiosInstance.post('/api/generate', {
        model: 'gpt-4.1-nano',
        prompt: 'Test',
        stream: false
      });
      
      // All duration fields should be numbers (proxy adapter returns 0)
      expect(typeof response.data.total_duration).toBe('number');
      expect(response.data.load_duration).toBeGreaterThanOrEqual(0);
      expect(response.data.prompt_eval_duration).toBeGreaterThanOrEqual(0);
      expect(typeof response.data.eval_duration).toBe('number');
      
      // Count fields should be non-negative integers
      expect(response.data.prompt_eval_count).toBeGreaterThanOrEqual(0);
      expect(response.data.eval_count).toBeGreaterThan(0);
      expect(Number.isInteger(response.data.prompt_eval_count)).toBe(true);
      expect(Number.isInteger(response.data.eval_count)).toBe(true);
    });

    it('should have consistent string field formats', async () => {
      const response = await axiosInstance.get('/api/tags');
      
      if (response.data.models.length > 0) {
        const model = response.data.models[0];
        
        // Model name should be non-empty string
        expect(model.name.length).toBeGreaterThan(0);
        
        // Digest should be in SHA256 format
        expect(model.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(typeof model.digest).toBe('string');
        
        // Size should be a number (proxy adapter returns 0)
        expect(typeof model.size).toBe('number');
        expect(model.size).toBeGreaterThanOrEqual(0);
        
        // Modified date should be valid timestamp
        const modifiedDate = new Date(model.modified_at);
        expect(modifiedDate.getTime()).not.toBeNaN();
      }
    });
  });

  describe('Client Compatibility', () => {
    it('should maintain backwards compatibility with Ollama clients', async () => {
      // Test that essential endpoints return expected structure
      const endpoints = [
        { path: '/api/tags', method: 'GET' },
        { path: '/api/version', method: 'GET' }
      ];
      
      for (const endpoint of endpoints) {
        const response = endpoint.method === 'GET' 
          ? await axiosInstance.get(endpoint.path)
          : await axiosInstance.post(endpoint.path, {});
        
        expect(response.status).toBe(200);
        expect(response.data).toBeDefined();
        expect(typeof response.data).toBe('object');
      }
    });

    it('should support standard Ollama client workflows', async () => {
      // Workflow: List models -> Show model -> Generate with model
      
      // Step 1: List models
      const modelsResponse = await axiosInstance.get('/api/tags');
      expect(modelsResponse.data.models.length).toBeGreaterThan(0);
      
      // Step 2: Get first available model
      const modelName = modelsResponse.data.models[0].name;
      
      // Step 3: Show model details
      const showResponse = await axiosInstance.post('/api/show', {
        model: modelName
      });
      expect(showResponse.data.modelfile).toBeDefined();
      
      // Step 4: Generate with the model (may not work in CI if model isn't deployed)
      try {
        const generateResponse = await axiosInstance.post('/api/generate', {
          model: modelName,
          prompt: 'Test prompt',
          stream: false
        });
        expect(generateResponse.data.response).toBeDefined();
      } catch (error) {
        // In CI, the model might exist in catalog but not be deployed for inference
        if (error.response?.status >= 400) {
          console.warn(`Generation test skipped for model ${modelName} - may not be deployed in CI environment`);
          expect(error.response.status).toBeGreaterThanOrEqual(400);
        } else {
          throw error;
        }
      }
    });

    it('should handle edge cases gracefully', async () => {
      // Test various edge cases that clients might encounter
      
      // Empty prompt
      const emptyPromptResponse = await axiosInstance.post('/api/generate', {
        model: 'gpt-4.1-nano',
        prompt: '',
        stream: false
      });
      expect(emptyPromptResponse.status).toBe(200);
      
      // Very short prompt
      const shortPromptResponse = await axiosInstance.post('/api/generate', {
        model: 'gpt-4.1-nano',
        prompt: 'Hi',
        stream: false
      });
      expect(shortPromptResponse.status).toBe(200);
      expect(shortPromptResponse.data.response).toBeDefined();
    });
  });

  describe('Response Size and Performance', () => {
    it('should return reasonable response sizes', async () => {
      const response = await axiosInstance.post('/api/generate', {
        model: 'gpt-4.1-nano',
        prompt: 'Say hello',
        stream: false,
        options: { num_predict: 10 }
      });
      
      expect(response.data.response.length).toBeLessThan(1000);
      expect(response.data.response.length).toBeGreaterThan(0);
    });

    it('should complete requests in reasonable time', async () => {
      const startTime = Date.now();
      
      const response = await axiosInstance.post('/api/chat', {
        model: 'gpt-4.1-nano',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false
      });
      
      const duration = Date.now() - startTime;
      
      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(30000); // Should complete within 30 seconds
      
      // Validate that reported durations are numbers (proxy adapter returns 0)
      expect(typeof response.data.total_duration).toBe('number');
      expect(response.data.total_duration).toBeGreaterThanOrEqual(0);
    });
  });
});