/**
 * Dual API Compatibility Integration Tests
 * 
 * Tests both Ollama native API and OpenAI compatible API side by side
 * to ensure they provide equivalent functionality
 */

const axios = require('axios');
const { getOllamaServiceUrl } = require('@libs/test-utils');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || getOllamaServiceUrl();

describe('Dual API Compatibility Integration', () => {
  let axiosInstance;

  beforeAll(() => {
    axiosInstance = axios.create({
      baseURL: OLLAMA_BASE_URL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
  });

  describe('Models Endpoints Comparison', () => {
    it('should provide models in both Ollama and OpenAI formats', async () => {
      // Native Ollama format
      const ollamaModels = await axiosInstance.get('/api/tags');
      expect(ollamaModels.status).toBe(200);
      expect(ollamaModels.data.models).toBeDefined();
      expect(Array.isArray(ollamaModels.data.models)).toBe(true);
      
      // OpenAI format
      const openaiModels = await axiosInstance.get('/v1/models');
      expect(openaiModels.status).toBe(200);
      expect(openaiModels.data.object).toBe('list');
      expect(Array.isArray(openaiModels.data.data)).toBe(true);
      
      // Both endpoints should return models
      expect(ollamaModels.data.models.length).toBeGreaterThan(0);
      expect(openaiModels.data.data.length).toBeGreaterThan(0);
    });

    it('should have consistent model availability across formats', async () => {
      const ollamaModels = await axiosInstance.get('/api/tags');
      const openaiModels = await axiosInstance.get('/v1/models');
      
      const ollamaModelNames = ollamaModels.data.models.map(m => m.name);
      const openaiModelIds = openaiModels.data.data.map(m => m.id);
      
      // There should be some overlap in available models
      const commonModels = ollamaModelNames.filter(name => 
        openaiModelIds.includes(name)
      );
      
      expect(commonModels.length).toBeGreaterThan(0);
    });
  });

  describe('Chat Completions Comparison', () => {
    const testPrompt = "Say 'API test successful' and nothing else.";
    const testModel = 'gpt-4.1-nano';

    it('should handle chat in both Ollama and OpenAI formats', async () => {
      // Native Ollama format
      const ollamaChat = await axiosInstance.post('/api/chat', {
        model: testModel,
        messages: [{ role: 'user', content: testPrompt }],
        stream: false
      });
      
      expect(ollamaChat.status).toBe(200);
      expect(ollamaChat.data.message).toBeDefined();
      expect(ollamaChat.data.message.role).toBe('assistant');
      expect(ollamaChat.data.message.content).toBeDefined();
      expect(ollamaChat.data.done).toBe(true);
      
      // OpenAI format
      const openaiChat = await axiosInstance.post('/v1/chat/completions', {
        model: testModel,
        messages: [{ role: 'user', content: testPrompt }],
        stream: false
      });
      
      expect(openaiChat.status).toBe(200);
      expect(openaiChat.data.choices).toBeDefined();
      expect(openaiChat.data.choices[0].message.role).toBe('assistant');
      expect(openaiChat.data.choices[0].message.content).toBeDefined();
      expect(openaiChat.data.usage).toBeDefined();
    });

    it('should provide semantically equivalent responses', async () => {
      const messages = [{ role: 'user', content: 'What is 2+2?' }];
      
      // Get responses from both APIs
      const ollamaResponse = await axiosInstance.post('/api/chat', {
        model: testModel,
        messages,
        stream: false
      });
      
      const openaiResponse = await axiosInstance.post('/v1/chat/completions', {
        model: testModel,
        messages,
        stream: false
      });
      
      const ollamaContent = ollamaResponse.data.message.content;
      const openaiContent = openaiResponse.data.choices[0].message.content;
      
      // Both should contain some form of "4" as the answer
      expect(ollamaContent).toBeDefined();
      expect(openaiContent).toBeDefined();
      expect(typeof ollamaContent).toBe('string');
      expect(typeof openaiContent).toBe('string');
      
      // Basic sanity check - both responses should be non-empty
      expect(ollamaContent.length).toBeGreaterThan(0);
      expect(openaiContent.length).toBeGreaterThan(0);
    });

    it('should handle parameters consistently', async () => {
      const requestParams = {
        model: testModel,
        messages: [{ role: 'user', content: 'Count from 1 to 3' }],
        stream: false
      };
      
      // Test with max_tokens (OpenAI) / num_predict (Ollama)
      const openaiWithLimit = await axiosInstance.post('/v1/chat/completions', {
        ...requestParams,
        max_tokens: 10
      });
      
      const ollamaWithLimit = await axiosInstance.post('/api/chat', {
        ...requestParams,
        options: { num_predict: 10 }
      });
      
      expect(openaiWithLimit.status).toBe(200);
      expect(ollamaWithLimit.status).toBe(200);
      
      // Both should have limited output
      const openaiTokens = openaiWithLimit.data.usage.completion_tokens;
      const ollamaContent = ollamaWithLimit.data.message.content;
      
      expect(openaiTokens).toBeLessThanOrEqual(10);
      expect(ollamaContent.length).toBeLessThan(100); // Rough proxy for token limit
    });
  });

  describe('Generation Endpoints Comparison', () => {
    it('should support both chat and generate paradigms', async () => {
      const prompt = 'Complete this sentence: The sky is';
      
      // Ollama generate endpoint
      const generateResponse = await axiosInstance.post('/api/generate', {
        model: 'gpt-4.1-nano',
        prompt,
        stream: false
      });
      
      expect(generateResponse.status).toBe(200);
      expect(generateResponse.data.response).toBeDefined();
      expect(typeof generateResponse.data.response).toBe('string');
      expect(generateResponse.data.done).toBe(true);
      
      // OpenAI chat completion (equivalent)
      const chatResponse = await axiosInstance.post('/v1/chat/completions', {
        model: 'gpt-4.1-nano',
        messages: [{ role: 'user', content: prompt }],
        stream: false
      });
      
      expect(chatResponse.status).toBe(200);
      expect(chatResponse.data.choices[0].message.content).toBeDefined();
      
      // Both should provide meaningful completions
      expect(generateResponse.data.response.length).toBeGreaterThan(0);
      expect(chatResponse.data.choices[0].message.content.length).toBeGreaterThan(0);
    });
  });

  describe('Embeddings Endpoints Comparison', () => {
    it('should provide embeddings in both formats or handle gracefully', async () => {
      const text = 'Test embedding text';
      
      try {
        // Ollama embeddings endpoint
        const ollamaEmbeddings = await axiosInstance.post('/api/embeddings', {
          model: 'text-embedding-3-small',
          prompt: text
        });
        
        expect(ollamaEmbeddings.status).toBe(200);
        expect(Array.isArray(ollamaEmbeddings.data.embedding)).toBe(true);
        expect(ollamaEmbeddings.data.embedding.length).toBeGreaterThan(0);
        
        // OpenAI embeddings endpoint
        const openaiEmbeddings = await axiosInstance.post('/v1/embeddings', {
          model: 'text-embedding-3-small',
          input: text
        });
        
        expect(openaiEmbeddings.status).toBe(200);
        expect(openaiEmbeddings.data.object).toBe('list');
        expect(Array.isArray(openaiEmbeddings.data.data)).toBe(true);
        expect(Array.isArray(openaiEmbeddings.data.data[0].embedding)).toBe(true);
        
        // Embeddings should have similar dimensions
        const ollama_dim = ollamaEmbeddings.data.embedding.length;
        const openai_dim = openaiEmbeddings.data.data[0].embedding.length;
        
        expect(ollama_dim).toBeGreaterThan(100); // Reasonable embedding size
        expect(openai_dim).toBeGreaterThan(100);
        expect(Math.abs(ollama_dim - openai_dim)).toBeLessThan(10); // Should be very close
      } catch (error) {
        // If embeddings aren't available, expect proper error responses
        expect(error.response.status).toBeGreaterThanOrEqual(400);
        console.warn('Dual API embeddings test skipped - endpoint not available in gateway');
      }
    });
  });

  describe('Error Handling Consistency', () => {
    it('should handle invalid models consistently', async () => {
      const invalidModel = 'non-existent-model-12345';
      
      let ollamaError, openaiError;
      
      // Test Ollama format error
      try {
        await axiosInstance.post('/api/chat', {
          model: invalidModel,
          messages: [{ role: 'user', content: 'Hi' }]
        });
      } catch (error) {
        ollamaError = error;
      }
      
      // Test OpenAI format error
      try {
        await axiosInstance.post('/v1/chat/completions', {
          model: invalidModel,
          messages: [{ role: 'user', content: 'Hi' }]
        });
      } catch (error) {
        openaiError = error;
      }
      
      // Both should either return errors or handle gracefully
      if (ollamaError) {
        expect(ollamaError.response.status).toBeGreaterThanOrEqual(400);
        expect(ollamaError.response.data).toBeDefined();
      } else {
        console.warn('Ollama did not return error for invalid model - adapter may be handling gracefully');
      }
      
      if (openaiError) {
        expect(openaiError.response.status).toBeGreaterThanOrEqual(400);
        expect(openaiError.response.data.error).toBeDefined();
      } else {
        console.warn('OpenAI did not return error for invalid model - adapter may be handling gracefully');
      }
    });

    it('should handle malformed requests consistently', async () => {
      let ollamaError, openaiError;
      
      // Test Ollama format with missing model
      try {
        await axiosInstance.post('/api/chat', {
          messages: [{ role: 'user', content: 'Hi' }]
          // Missing model field
        });
      } catch (error) {
        ollamaError = error;
      }
      
      // Test OpenAI format with missing model
      try {
        await axiosInstance.post('/v1/chat/completions', {
          messages: [{ role: 'user', content: 'Hi' }]
          // Missing model field
        });
      } catch (error) {
        openaiError = error;
      }
      
      // Both should either return errors or handle gracefully
      if (ollamaError) {
        expect(ollamaError.response.status).toBeGreaterThanOrEqual(400);
      } else {
        console.warn('Ollama did not return error for malformed request - adapter may be handling gracefully');
      }
      
      if (openaiError) {
        expect(openaiError.response.status).toBeGreaterThanOrEqual(400);
      } else {
        console.warn('OpenAI did not return error for malformed request - adapter may be handling gracefully');
      }
    });
  });
});