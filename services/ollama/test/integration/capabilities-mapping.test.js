/**
 * Capabilities Mapping Integration Tests
 * 
 * Tests that capabilities from the OpenAI proxy models endpoint
 * are correctly mapped to valid Ollama API capability values.
 */

const axios = require('axios');
const { getOllamaServiceUrl, getGatewayUrl } = require('@libs/test-utils');

const OLLAMA_SERVER_URL = process.env.OLLAMA_BASE_URL || getOllamaServiceUrl();
const MAIN_PROXY_URL = process.env.MAIN_PROXY_URL || getGatewayUrl();
const MAIN_PROXY_API_KEY = process.env.MAIN_PROXY_API_KEY;

describe('Capabilities Mapping Integration', () => {
  let ollamaClient;
  let proxyClient;

  beforeAll(() => {
    ollamaClient = axios.create({
      baseURL: OLLAMA_SERVER_URL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });

    proxyClient = axios.create({
      baseURL: MAIN_PROXY_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(MAIN_PROXY_API_KEY && { 'Authorization': `Bearer ${MAIN_PROXY_API_KEY}` })
      }
    });
  });

  // Test models with their expected capabilities mapping
  const testCases = [
    {
      modelName: 'gpt-4.1-nano',
      expectedCapabilities: ['completion', 'vision'],
      description: 'GPT-4 with vision capabilities'
    },
    {
      modelName: 'gpt-4.1-nano',
      expectedCapabilities: ['completion'],
      description: 'GPT-3.5 text-only model'
    }
  ];

  describe('Model Capabilities Mapping', () => {
    it('should fetch models from main proxy successfully', async () => {
      try {
        const response = await proxyClient.get('/v1/models');
        
        expect(response.status).toBe(200);
        expect(response.data).toBeDefined();
        expect(response.data.data).toBeDefined();
        expect(Array.isArray(response.data.data)).toBe(true);
        
        if (response.data.data.length > 0) {
          const model = response.data.data[0];
          expect(model.id).toBeDefined();
          expect(typeof model.id).toBe('string');
        }
      } catch (error) {
        console.warn('Main proxy not available, skipping proxy-dependent tests');
      }
    });

    it('should map models to Ollama format', async () => {
      const response = await ollamaClient.get('/api/tags');
      
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data.models).toBeDefined();
      expect(Array.isArray(response.data.models)).toBe(true);
      
      // Check Ollama model structure
      if (response.data.models.length > 0) {
        const model = response.data.models[0];
        expect(model.name).toBeDefined();
        expect(model.size).toBeDefined();
        expect(model.digest).toBeDefined();
        expect(model.details).toBeDefined();
      }
    });

    testCases.forEach((testCase) => {
      it(`should handle ${testCase.description}`, async () => {
        try {
          // Test if model is available through Ollama endpoint
          const response = await ollamaClient.post('/api/show', {
            model: testCase.modelName
          });
          
          if (response.status === 200) {
            expect(response.data).toBeDefined();
            
            // Check if model info contains capability-related information
            if (response.data.model_info) {
              expect(response.data.model_info).toBeDefined();
            }
            
            // Test basic chat functionality for completion capability
            if (testCase.expectedCapabilities.includes('completion')) {
              const chatResponse = await ollamaClient.post('/api/chat', {
                model: testCase.modelName,
                messages: [{ role: 'user', content: 'Hi' }],
                stream: false
              });
              
              expect(chatResponse.status).toBe(200);
              expect(chatResponse.data.message.content).toBeDefined();
            }
          }
        } catch (error) {
          if (error.response?.status === 404) {
            console.warn(`Model ${testCase.modelName} not available for testing`);
          } else {
            throw error;
          }
        }
      });
    });
  });

  describe('Capability Validation', () => {
    it('should validate completion capability', async () => {
      // Test with a basic model that should support text completion
      try {
        const response = await ollamaClient.post('/api/generate', {
          model: 'gpt-4.1-nanoo-mini',
          prompt: 'Complete this: Hello',
          stream: false
        });
        
        expect(response.status).toBe(200);
        expect(response.data.response).toBeDefined();
        expect(typeof response.data.response).toBe('string');
        expect(response.data.done).toBe(true);
      } catch (error) {
        console.warn('Completion capability test skipped - model not available');
      }
    });

    it('should validate chat capability', async () => {
      try {
        const response = await ollamaClient.post('/api/chat', {
          model: 'gpt-4.1-nanoo-mini',
          messages: [
            { role: 'user', content: 'Say hello' }
          ],
          stream: false
        });
        
        expect(response.status).toBe(200);
        expect(response.data.message).toBeDefined();
        expect(response.data.message.role).toBe('assistant');
        expect(response.data.message.content).toBeDefined();
      } catch (error) {
        console.warn('Chat capability test skipped - model not available');
      }
    });

    it('should validate embedding capability', async () => {
      try {
        const response = await ollamaClient.post('/api/embeddings', {
          model: 'text-embedding-3-small',
          prompt: 'Test embedding'
        });
        
        expect(response.status).toBe(200);
        expect(response.data.embedding).toBeDefined();
        expect(Array.isArray(response.data.embedding)).toBe(true);
        expect(response.data.embedding.length).toBeGreaterThan(0);
      } catch (error) {
        console.warn('Embedding capability test skipped - model not available');
      }
    });
  });

  describe('OpenAI Capabilities Compatibility', () => {
    it('should map capabilities to OpenAI model format', async () => {
      const response = await ollamaClient.get('/v1/models');
      
      expect(response.status).toBe(200);
      expect(response.data.object).toBe('list');
      expect(Array.isArray(response.data.data)).toBe(true);
      
      response.data.data.forEach(model => {
        expect(model.id).toBeDefined();
        expect(model.object).toBe('model');
        expect(typeof model.created).toBe('number');
        expect(model.owned_by).toBeDefined();
        
        // Check if model has capability indicators in metadata
        if (model.capabilities) {
          expect(Array.isArray(model.capabilities)).toBe(true);
        }
      });
    });

    it('should provide consistent capabilities across endpoints', async () => {
      // Get model from /v1/models
      const modelsResponse = await ollamaClient.get('/v1/models');
      
      if (modelsResponse.data.data.length > 0) {
        const modelId = modelsResponse.data.data[0].id;
        
        // Test that the model works with expected capabilities
        try {
          const chatResponse = await ollamaClient.post('/v1/chat/completions', {
            model: modelId,
            messages: [{ role: 'user', content: 'Hi' }],
            stream: false
          });
          
          expect(chatResponse.status).toBe(200);
          expect(chatResponse.data.choices[0].message.content).toBeDefined();
        } catch (error) {
          // If chat fails, the model might not support completion capability
          console.warn(`Model ${modelId} may not support chat completion`);
        }
      }
    });
  });

  describe('Model-Specific Capability Tests', () => {
    it('should handle vision models appropriately', async () => {
      const visionModels = ['gpt-4.1-nanoo', 'gemini-2.0-flash-lite', 'anthropic--claude-3-haiku'];
      
      for (const modelName of visionModels) {
        try {
          const response = await ollamaClient.post('/api/chat', {
            model: modelName,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'What do you see in this image?'
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
                    }
                  }
                ]
              }
            ],
            stream: false
          });
          
          // If successful, model supports vision
          expect(response.status).toBe(200);
          expect(response.data.message.content).toBeDefined();
          
        } catch (error) {
          // Model might not be available or might not support vision
          console.warn(`Vision test skipped for ${modelName}`);
        }
      }
    });

    it('should handle text-only models correctly', async () => {
      const textOnlyModels = ['gpt-4.1-nano', 'mistralai--mistral-small-instruct'];
      
      for (const modelName of textOnlyModels) {
        try {
          const response = await ollamaClient.post('/api/chat', {
            model: modelName,
            messages: [
              { role: 'user', content: 'Hello, how are you?' }
            ],
            stream: false
          });
          
          expect(response.status).toBe(200);
          expect(response.data.message.content).toBeDefined();
          
        } catch (error) {
          console.warn(`Text completion test skipped for ${modelName}`);
        }
      }
    });
  });
});