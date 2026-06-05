// Test setup file for Ollama service
const { getGatewayUrl, getOllamaServiceUrl } = require('@libs/test-utils');

// Global test setup
beforeAll(() => {
  // Set up test environment variables
  process.env.NODE_ENV = 'test';
  process.env.PORT = '11434';
  process.env.MAIN_PROXY_URL = process.env.MAIN_PROXY_URL || getGatewayUrl();
  process.env.OLLAMA_BASE_URL = getOllamaServiceUrl();
  
  // Set timeouts for API calls (handled by Jest config)
});

afterAll(async () => {
  // Clean up after all tests
  // Force close any remaining connections
  if (global.gc) {
    global.gc();
  }
  
  // Give time for async operations to complete
  await new Promise(resolve => setTimeout(resolve, 100));
});

// Mock console methods in test environment to reduce noise
// (Uncomment lines below to suppress console output during tests)
/*
global.console = {
  ...console,
  log: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
*/

// Common test utilities
global.testUtils = {
  // Wait utility for async operations
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  
  // Mock Ollama API responses
  mockOllamaResponse: {
    tags: {
      models: [
        {
          name: 'test-model:latest',
          model: 'test-model',
          modified_at: '2023-01-01T00:00:00Z',
          size: 1000000,
          digest: 'sha256:test123',
          details: {
            format: 'gguf',
            family: 'test',
            parameter_size: '7B'
          }
        }
      ]
    },
    generate: {
      model: 'test-model',
      created_at: '2023-01-01T00:00:00Z',
      response: 'Test response from Ollama',
      done: true,
      context: [1, 2, 3],
      total_duration: 1000000,
      load_duration: 500000,
      prompt_eval_count: 10,
      prompt_eval_duration: 200000,
      eval_count: 15,
      eval_duration: 300000
    },
    chat: {
      model: 'test-model',
      created_at: '2023-01-01T00:00:00Z',
      message: {
        role: 'assistant',
        content: 'Test response from Ollama chat'
      },
      done: true
    }
  }
};