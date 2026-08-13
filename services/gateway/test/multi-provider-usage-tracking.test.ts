import { describe, beforeAll, afterAll, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { createUsageMetrics, emitUsageEvent, updateTokenCounts } from '../src/utils/usageTracker';
import usageEmitter from '../src/services/usageEventEmitter';

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

// Mock unified auth config - default to non-standalone
jest.mock('../src/config/unifiedAuthConfig', () => ({
  isStandaloneMode: jest.fn(() => false)
}));

// Mock admin service client
const mockCallAdminAction = jest.fn();
// @ts-ignore - Jest mock typing issues
mockCallAdminAction.mockResolvedValue({
  processed: 1,
  status: 'success'
});

const mockAdminServiceClient: any = {
  callAdminAction: mockCallAdminAction
};

jest.mock('../src/clients/adminServiceClient', () => ({
  default: mockAdminServiceClient,
  adminServiceClient: mockAdminServiceClient
}));

describe('Multi-Provider Usage Tracking Integration Tests', () => {
  let app: express.Application;
  let server: any;

  beforeAll(async () => {
    // Set up a test Express app that simulates all providers
    app = express();
    app.use(express.json());

    // Middleware to simulate different authentication types
    app.use((req: any, res, next) => {
      req.debugRequestId = `test-${Date.now()}`;
      
      // Simulate different auth types based on endpoint
      if (req.path.includes('/anthropic/')) {
        req.unifiedAuth = {
          valid: true,
          authType: 'api_key',
          data: { id: 'anthropic-api-key-id' }
        };
      } else if (req.path.includes('/aws-bedrock/')) {
        req.unifiedAuth = {
          valid: true,
          authType: 'aws_credential',
          data: { keyId: 'aws-bedrock-key-id' }
        };
      } else if (req.path.includes('/openai/')) {
        req.unifiedAuth = {
          valid: true,
          authType: 'api_key',
          data: { id: 'openai-api-key-id' }
        };
      } else if (req.path.includes('/openrouter/')) {
        req.unifiedAuth = {
          valid: true,
          authType: 'api_key',
          data: { id: 'openrouter-api-key-id' }
        };
      }
      next();
    });

    // Anthropic endpoint simulation
    app.post('/anthropic/v1/messages', async (req: any, res) => {
      const metrics = createUsageMetrics();
      updateTokenCounts(metrics, 200, 300);
      
      // Add small delay to ensure responseTime > 0
      await new Promise(resolve => setTimeout(resolve, 5));
      
      await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 200);
      
      res.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from Anthropic!' }],
        model: 'claude-3-5-sonnet',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 200,
          output_tokens: 300
        }
      });
    });

    // AWS Bedrock endpoint simulation
    app.post('/aws-bedrock/model/:modelId/invoke', async (req: any, res) => {
      const metrics = createUsageMetrics();
      updateTokenCounts(metrics, 150, 250);
      
      // Add small delay to ensure responseTime > 0
      await new Promise(resolve => setTimeout(resolve, 5));
      
      await emitUsageEvent(req, metrics, req.params.modelId, 200);
      
      res.json({
        output: {
          message: {
            content: [{ text: 'Hello from AWS Bedrock!' }]
          }
        },
        usage: {
          inputTokens: 150,
          outputTokens: 250
        },
        stopReason: 'end_turn'
      });
    });

    // OpenAI endpoint simulation
    app.post('/openai/v1/chat/completions', async (req: any, res) => {
      const metrics = createUsageMetrics();
      updateTokenCounts(metrics, 100, 200);
      
      // Add small delay to ensure responseTime > 0
      await new Promise(resolve => setTimeout(resolve, 5));
      
      await emitUsageEvent(req, metrics, req.body.model, 200);
      
      res.json({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Date.now(),
        model: req.body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from OpenAI!'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 200,
          total_tokens: 300
        }
      });
    });

    // OpenRouter endpoint simulation
    app.post('/openrouter/v1/chat/completions', async (req: any, res) => {
      const metrics = createUsageMetrics();
      updateTokenCounts(metrics, 120, 180);
      
      // Add small delay to ensure responseTime > 0
      await new Promise(resolve => setTimeout(resolve, 5));
      
      await emitUsageEvent(req, metrics, req.body.model, 200);
      
      res.json({
        id: 'chatcmpl-openrouter-test',
        object: 'chat.completion',
        created: Date.now(),
        model: req.body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from OpenRouter!'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 180,
          total_tokens: 300
        }
      });
    });

    // Error simulation endpoints
    app.post('/anthropic/v1/error', async (req: any, res) => {
      const metrics = createUsageMetrics();
      await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 400);
      
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Invalid request'
        }
      });
    });

    app.post('/aws-bedrock/model/:modelId/error', async (req: any, res) => {
      const metrics = createUsageMetrics();
      await emitUsageEvent(req, metrics, req.params.modelId, 500);
      
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'InternalServerError'
        }
      });
    });

    // Awaited: a request issued before the socket is listening is the same
    // race this change exists to remove. The server was already created
    // here but every request below still went to `app`, so it was never
    // actually used.
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    usageEmitter.getAndClearMemoryQueue();
    // @ts-ignore - Jest mock typing issues
    mockAdminServiceClient.callAdminAction.mockResolvedValue({
      processed: 1,
      status: 'success'
    });
  });

  describe('Multi-Provider Usage Tracking', () => {
    it('should track usage for all providers correctly', async () => {
      usageEmitter.setValkeyClient(null); // Use memory mode

      // Test Anthropic
      await request(server)
        .post('/anthropic/v1/messages')
        .send({
          model: 'claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(200);

      // Test AWS Bedrock
      await request(server)
        .post('/aws-bedrock/model/anthropic.claude-3-5-sonnet-v2/invoke')
        .send({
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(200);

      // Test OpenAI
      await request(server)
        .post('/openai/v1/chat/completions')
        .send({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(200);

      // Test OpenRouter
      await request(server)
        .post('/openrouter/v1/chat/completions')
        .send({
          model: 'anthropic/claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(200);

      // Verify all usage events were captured
      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(4);

      // Verify provider-specific events (now all providers are 'unknown' at gateway level)
      const anthropicEvent = events.find(e => e.model === 'claude-3-5-sonnet');
      expect(anthropicEvent).toMatchObject({
        provider: 'unknown',
        model: 'claude-3-5-sonnet',
        authType: 'api_key',
        credentialId: 'anthropic-api-key-id',
        inputTokens: 200,
        outputTokens: 300,
        statusCode: 200
      });

      const bedrockEvent = events.find(e => e.model === 'anthropic.claude-3-5-sonnet-v2');
      expect(bedrockEvent).toMatchObject({
        provider: 'unknown',
        model: 'anthropic.claude-3-5-sonnet-v2',
        authType: 'aws_credential',
        credentialId: 'aws-bedrock-key-id',
        inputTokens: 150,
        outputTokens: 250,
        statusCode: 200
      });

      const openaiEvent = events.find(e => e.model === 'gpt-4o');
      expect(openaiEvent).toMatchObject({
        provider: 'unknown',
        model: 'gpt-4o',
        authType: 'api_key',
        credentialId: 'openai-api-key-id',
        inputTokens: 100,
        outputTokens: 200,
        statusCode: 200
      });

      const openrouterEvent = events.find(e => e.model === 'anthropic/claude-3-5-sonnet');
      expect(openrouterEvent).toMatchObject({
        provider: 'unknown',
        model: 'anthropic/claude-3-5-sonnet',
        authType: 'api_key',
        credentialId: 'openrouter-api-key-id',
        inputTokens: 120,
        outputTokens: 180,
        statusCode: 200
      });

      // Verify all events have valid timestamps and response times
      events.forEach(event => {
        expect(event.timestamp).toBeGreaterThan(0);
        expect(event.responseTime).toBeGreaterThan(0);
        expect(event.requestId).toMatch(/^test-\d+$/);
      });
    });

    it('should track error cases for all providers', async () => {
      usageEmitter.setValkeyClient(null);

      // Test Anthropic error
      await request(server)
        .post('/anthropic/v1/error')
        .send({
          model: 'claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'Error test' }]
        })
        .expect(400);

      // Test AWS Bedrock error
      await request(server)
        .post('/aws-bedrock/model/test-model/error')
        .send({
          messages: [{ role: 'user', content: 'Error test' }]
        })
        .expect(500);

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(2);

      const anthropicError = events.find(e => e.model === 'claude-3-5-sonnet');
      expect(anthropicError).toMatchObject({
        provider: 'unknown',
        model: 'claude-3-5-sonnet',
        inputTokens: 0,
        outputTokens: 0,
        statusCode: 400
      });

      const bedrockError = events.find(e => e.model === 'test-model');
      expect(bedrockError).toMatchObject({
        provider: 'unknown',
        model: 'test-model',
        inputTokens: 0,
        outputTokens: 0,
        statusCode: 500
      });
    });

    it('should handle different authentication types correctly', async () => {
      usageEmitter.setValkeyClient(null);

      // Test with API key auth (Anthropic)
      await request(server)
        .post('/anthropic/v1/messages')
        .send({
          model: 'claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'Auth test' }]
        });

      // Test with AWS credential auth (Bedrock)
      await request(server)
        .post('/aws-bedrock/model/test-model/invoke')
        .send({
          messages: [{ role: 'user', content: 'Auth test' }]
        });

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(2);

      const apiKeyEvent = events.find(e => e.authType === 'api_key');
      const awsCredEvent = events.find(e => e.authType === 'aws_credential');

      expect(apiKeyEvent).toBeDefined();
      expect(awsCredEvent).toBeDefined();

      expect(apiKeyEvent?.credentialId).toBe('anthropic-api-key-id');
      expect(awsCredEvent?.credentialId).toBe('aws-bedrock-key-id');
    });

    it('should handle concurrent requests from different providers', async () => {
      usageEmitter.setValkeyClient(null);

      const requests = [
        request(server).post('/anthropic/v1/messages').send({ model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: '1' }] }),
        request(server).post('/aws-bedrock/model/model1/invoke').send({ messages: [{ role: 'user', content: '2' }] }),
        request(server).post('/openai/v1/chat/completions').send({ model: 'gpt-4o', messages: [{ role: 'user', content: '3' }] }),
        request(server).post('/openrouter/v1/chat/completions').send({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: '4' }] }),
        request(server).post('/anthropic/v1/messages').send({ model: 'claude-3-5-haiku', messages: [{ role: 'user', content: '5' }] })
      ];

      const responses = await Promise.all(requests);
      
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(5);

      // Verify model distribution (since providers are now 'unknown')
      const modelCounts = events.reduce((acc, event) => {
        const modelKey = event.model.includes('claude') ? 'claude' : 
                        event.model.includes('gpt') ? 'gpt' :
                        event.model.includes('model1') ? 'bedrock' :
                        'other';
        acc[modelKey] = (acc[modelKey] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      expect(modelCounts.claude).toBe(2); // Two Anthropic models
      expect(modelCounts.bedrock).toBe(1); // One Bedrock model
      expect(modelCounts.gpt).toBe(2); // OpenAI and OpenRouter gpt models
    });

    it('should calculate different costs per provider', async () => {
      usageEmitter.setValkeyClient(null);

      // Test different token counts per provider
      await request(server)
        .post('/anthropic/v1/messages')
        .send({ model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'Cost test' }] });

      await request(server)
        .post('/openai/v1/chat/completions')
        .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Cost test' }] });

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(2);

      const anthropicEvent = events.find(e => e.model === 'claude-3-5-sonnet');
      const openaiEvent = events.find(e => e.model === 'gpt-4o');

      // Verify different token counts
      expect(anthropicEvent?.inputTokens).toBe(200);
      expect(anthropicEvent?.outputTokens).toBe(300);
      expect(openaiEvent?.inputTokens).toBe(100);
      expect(openaiEvent?.outputTokens).toBe(200);

      // Both events should have valid cost calculations
      // (Cost calculation happens in admin service, not gateway)
      expect(anthropicEvent?.model).toBe('claude-3-5-sonnet');
      expect(openaiEvent?.model).toBe('gpt-4o');
    });
  });

  describe('Admin Service Integration', () => {
    it('should flush multi-provider events to admin service', async () => {
      usageEmitter.setValkeyClient(null);

      // Generate events from multiple providers
      await request(server).post('/anthropic/v1/messages').send({ model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'test' }] });
      await request(server).post('/openai/v1/chat/completions').send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] });
      await request(server).post('/aws-bedrock/model/test-model/invoke').send({ messages: [{ role: 'user', content: 'test' }] });

      // Verify events are in memory queue
      expect(usageEmitter.getQueueSize()).toBe(3);

      // Manually trigger flush
      await usageEmitter.flushToAdminService();

      // Verify mock was called
      expect(mockAdminServiceClient.callAdminAction).toHaveBeenCalledWith(
        'processUsageEvents',
        {
          events: expect.arrayContaining([
            expect.objectContaining({ provider: 'unknown', model: 'claude-3-5-sonnet' }),
            expect.objectContaining({ provider: 'unknown', model: 'gpt-4o' }),
            expect.objectContaining({ provider: 'unknown', model: 'test-model' })
          ])
        }
      );

      // Verify queue is empty after flush
      expect(usageEmitter.getQueueSize()).toBe(0);
    });

    it('should handle admin service processing errors gracefully', async () => {
      usageEmitter.setValkeyClient(null);
      // @ts-ignore - Jest mock typing issues
      mockAdminServiceClient.callAdminAction.mockRejectedValue(new Error('Admin service down'));

      await request(server).post('/anthropic/v1/messages').send({ model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'test' }] });

      // Should not throw
      await expect(usageEmitter.flushToAdminService()).resolves.toBeUndefined();

      // Queue should be empty (events lost on failure - by design)
      expect(usageEmitter.getQueueSize()).toBe(0);
    });
  });

  describe('Performance and Reliability', () => {
    it('should handle high-volume multi-provider requests', async () => {
      usageEmitter.setValkeyClient(null);

      const providers = [
        { path: '/anthropic/v1/messages', payload: { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'test' }] } },
        { path: '/openai/v1/chat/completions', payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] } },
        { path: '/aws-bedrock/model/test/invoke', payload: { messages: [{ role: 'user', content: 'test' }] } },
        { path: '/openrouter/v1/chat/completions', payload: { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'test' }] } }
      ];

      const requests: Promise<any>[] = [];
      for (let i = 0; i < 25; i++) {
        const provider = providers[i % providers.length];
        requests.push(request(server).post(provider.path).send(provider.payload));
      }

      const startTime = Date.now();
      await Promise.all(requests);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(25);

      // Verify even distribution by model patterns
      const modelPatternCounts = events.reduce((acc, event) => {
        const pattern = event.model.includes('claude') ? 'claude' : 
                       event.model.includes('gpt') ? 'gpt' :
                       event.model.includes('test') ? 'bedrock' :
                       'other';
        acc[pattern] = (acc[pattern] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      expect(events).toHaveLength(25);
      // Each pattern should have some events (exact count depends on distribution)
      expect(modelPatternCounts.claude).toBeGreaterThan(5);
      expect(modelPatternCounts.gpt).toBeGreaterThan(5);
      expect(modelPatternCounts.bedrock).toBeGreaterThan(5);
    });

    it('should maintain usage tracking accuracy under load', async () => {
      usageEmitter.setValkeyClient(null);

      // Create specific token patterns for verification
      const testCases = [
        { provider: 'anthropic', path: '/anthropic/v1/messages', expectedInput: 200, expectedOutput: 300 },
        { provider: 'openai', path: '/openai/v1/chat/completions', expectedInput: 100, expectedOutput: 200 },
        { provider: 'aws-bedrock', path: '/aws-bedrock/model/test/invoke', expectedInput: 150, expectedOutput: 250 },
        { provider: 'openrouter', path: '/openrouter/v1/chat/completions', expectedInput: 120, expectedOutput: 180 }
      ];

      const requests = testCases.map(testCase => {
        const payload = testCase.provider === 'aws-bedrock' 
          ? { messages: [{ role: 'user', content: 'test' }] }
          : { model: 'test-model', messages: [{ role: 'user', content: 'test' }] };
        
        return request(server).post(testCase.path).send(payload);
      });

      await Promise.all(requests);

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(4);

      // Verify token accuracy by finding events by their expected characteristics
      testCases.forEach(testCase => {
        let event;
        if (testCase.provider === 'anthropic') {
          // Anthropic endpoint uses claude-3-5-sonnet with 200/300 tokens
          event = events.find(e => e.inputTokens === 200 && e.outputTokens === 300);
        } else if (testCase.provider === 'openai') {
          // OpenAI endpoint uses test-model with 100/200 tokens  
          event = events.find(e => e.inputTokens === 100 && e.outputTokens === 200);
        } else if (testCase.provider === 'aws-bedrock') {
          // Bedrock endpoint uses 'test' model with 150/250 tokens
          event = events.find(e => e.inputTokens === 150 && e.outputTokens === 250);
        } else if (testCase.provider === 'openrouter') {
          // OpenRouter endpoint uses test-model with 120/180 tokens
          event = events.find(e => e.inputTokens === 120 && e.outputTokens === 180);
        }
        expect(event).toBeDefined();
        expect(event?.inputTokens).toBe(testCase.expectedInput);
        expect(event?.outputTokens).toBe(testCase.expectedOutput);
      });
    });
  });
});