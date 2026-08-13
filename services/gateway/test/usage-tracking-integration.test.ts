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

describe('Usage Tracking Integration Tests', () => {
  let app: express.Application;
  let server: any;

  beforeAll(async () => {
    // Set up a minimal Express app for testing
    app = express();
    app.use(express.json());

    // Middleware to simulate authentication
    app.use((req: any, res, next) => {
      req.debugRequestId = `test-${Date.now()}`;
      req.unifiedAuth = {
        valid: true,
        authType: 'api_key',
        data: { id: 'test-api-key-id' }
      };
      next();
    });

    // Test endpoint that simulates usage tracking
    app.post('/test/anthropic', async (req: any, res) => {
      const metrics = createUsageMetrics();
      
      // Simulate token usage
      updateTokenCounts(metrics, 150, 250);
      
      // Add small delay to ensure responseTime > 0
      await new Promise(resolve => setTimeout(resolve, 5));
      
      // Emit usage event
      await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 200);
      
      res.json({ success: true, tokens: { input: 150, output: 250 } });
    });

    // Test endpoint with error
    app.post('/test/error', async (req: any, res) => {
      const metrics = createUsageMetrics();
      
      // Add small delay to ensure responseTime > 0
      await new Promise(resolve => setTimeout(resolve, 5));
      
      // Emit usage event with error status
      await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 500);
      
      res.status(500).json({ error: 'Test error' });
    });

    // Test endpoint for AWS credentials
    app.post('/test/aws', async (req: any, res) => {
      req.unifiedAuth = {
        valid: true,
        authType: 'aws_credential',
        data: { keyId: 'test-aws-key-id' }
      };
      
      const metrics = createUsageMetrics();
      updateTokenCounts(metrics, 75, 125);
      
      // Add small delay to ensure responseTime > 0
      await new Promise(resolve => setTimeout(resolve, 5));
      
      await emitUsageEvent(req, metrics, 'claude-3-5-haiku', 200);
      
      res.json({ success: true, tokens: { input: 75, output: 125 } });
    });

    // Awaited: a request issued before the socket is listening is the same
    // race this change removes. The server already existed here, but every
    // request below still went to `app`, so it was never used.
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear any existing events in the emitter
    usageEmitter.getAndClearMemoryQueue();
  });

  describe('End-to-End Usage Tracking', () => {
    it('should track usage for successful API key request', async () => {
      // Set emitter to memory mode
      usageEmitter.setValkeyClient(null);

      const response = await request(server)
        .post('/test/anthropic')
        .send({ message: 'Hello, Claude!' })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Check that usage event was captured
      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event).toMatchObject({
        authType: 'api_key',
        credentialId: 'test-api-key-id',
        provider: 'unknown',
        model: 'claude-3-5-sonnet',
        inputTokens: 150,
        outputTokens: 250,
        statusCode: 200
      });

      expect(event.requestId).toMatch(/^test-\d+$/);
      expect(event.timestamp).toBeGreaterThan(0);
      expect(event.responseTime).toBeGreaterThan(0);
    });

    it('should track usage for AWS credential request', async () => {
      usageEmitter.setValkeyClient(null);

      const response = await request(server)
        .post('/test/aws')
        .send({ message: 'Hello from AWS!' })
        .expect(200);

      expect(response.body.success).toBe(true);

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event).toMatchObject({
        authType: 'aws_credential',
        credentialId: 'test-aws-key-id',
        provider: 'unknown',
        model: 'claude-3-5-haiku',
        inputTokens: 75,
        outputTokens: 125,
        statusCode: 200
      });
    });

    it('should track usage for error responses', async () => {
      usageEmitter.setValkeyClient(null);

      await request(server)
        .post('/test/error')
        .send({ message: 'This will fail' })
        .expect(500);

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event).toMatchObject({
        authType: 'api_key',
        credentialId: 'test-api-key-id',
        provider: 'unknown',
        model: 'claude-3-5-sonnet',
        inputTokens: 0,
        outputTokens: 0,
        statusCode: 500
      });
    });

    it('should handle multiple concurrent requests', async () => {
      usageEmitter.setValkeyClient(null);

      const requests = Array(5).fill(null).map((_, index) => 
        request(server)
          .post('/test/anthropic')
          .send({ message: `Request ${index}` })
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(5);

      events.forEach(event => {
        expect(event).toMatchObject({
          authType: 'api_key',
          provider: 'unknown',
          model: 'claude-3-5-sonnet',
          inputTokens: 150,
          outputTokens: 250,
          statusCode: 200
        });
      });
    });
  });

  describe('Admin Service Integration', () => {
    beforeEach(() => {
      // @ts-ignore - Jest mock typing issues
      mockAdminServiceClient.callAdminAction.mockResolvedValue({
        processed: 1,
        status: 'success'
      });
    });

    it('should flush events to admin service when Valkey unavailable', async () => {
      usageEmitter.setValkeyClient(null);

      // Generate some usage events
      await request(server)
        .post('/test/anthropic')
        .send({ message: 'Test message' });

      // Manually trigger flush
      await usageEmitter.flushToAdminService();

      expect(mockAdminServiceClient.callAdminAction).toHaveBeenCalledWith(
        'processUsageEvents',
        {
          events: expect.arrayContaining([
            expect.objectContaining({
              authType: 'api_key',
              provider: 'unknown',
              model: 'claude-3-5-sonnet'
            })
          ])
        }
      );
    });

    it('should handle admin service flush errors gracefully', async () => {
      usageEmitter.setValkeyClient(null);

      // @ts-ignore - Jest mock typing issues
      mockAdminServiceClient.callAdminAction.mockRejectedValue(
        new Error('Admin service unavailable')
      );

      // Generate usage event
      await request(server)
        .post('/test/anthropic')
        .send({ message: 'Test message' });

      // Flush should not throw
      await expect(usageEmitter.flushToAdminService()).resolves.toBeUndefined();

      // Queue should be empty (events lost on failure - by design for simplicity)
      expect(usageEmitter.getQueueSize()).toBe(0);
    });

    it('should not flush when Valkey is available', async () => {
      const mockPublish = jest.fn();
      // @ts-ignore - Jest mock typing issues
      mockPublish.mockResolvedValue(undefined);
      
      const mockValkeyClient: any = {
        publish: mockPublish,
        status: 'ready'
      };

      usageEmitter.setValkeyClient(mockValkeyClient);

      // Generate usage event
      await request(server)
        .post('/test/anthropic')
        .send({ message: 'Test message' });

      // Should publish to Valkey
      expect(mockValkeyClient.publish).toHaveBeenCalledWith(
        'usage-events',
        expect.stringContaining('claude-3-5-sonnet')
      );

      // Manual flush should skip
      await usageEmitter.flushToAdminService();

      // Should not have called admin service
      expect(mockAdminServiceClient.callAdminAction).not.toHaveBeenCalled();
    });
  });

  describe('Valkey Integration', () => {
    it('should publish events to Valkey when available', async () => {
      const mockPublish = jest.fn();
      // @ts-ignore - Jest mock typing issues
      mockPublish.mockResolvedValue(undefined);
      
      const mockValkeyClient: any = {
        publish: mockPublish,
        status: 'ready'
      };

      usageEmitter.setValkeyClient(mockValkeyClient);

      await request(server)
        .post('/test/anthropic')
        .send({ message: 'Valkey test' });

      expect(mockValkeyClient.publish).toHaveBeenCalledWith(
        'usage-events',
        expect.stringMatching(/claude-3-5-sonnet/)
      );

      // Parse the published message to verify structure
      const publishedMessage = mockValkeyClient.publish.mock.calls[0][1] as string;
      const event = JSON.parse(publishedMessage);

      expect(event).toMatchObject({
        authType: 'api_key',
        credentialId: 'test-api-key-id',
        provider: 'unknown',
        model: 'claude-3-5-sonnet',
        inputTokens: 150,
        outputTokens: 250,
        statusCode: 200
      });
    });

    it('should fallback to memory when Valkey publish fails', async () => {
      const failingPublish = jest.fn();
      // @ts-ignore - Jest mock typing issues
      failingPublish.mockRejectedValue(new Error('Valkey publish failed'));
      
      const failingValkeyClient: any = {
        publish: failingPublish,
        status: 'ready'
      };

      usageEmitter.setValkeyClient(failingValkeyClient);

      await request(server)
        .post('/test/anthropic')
        .send({ message: 'Fallback test' });

      expect(failingValkeyClient.publish).toHaveBeenCalled();
      
      // Should have fallen back to memory queue
      expect(usageEmitter.getQueueSize()).toBe(1);

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(1);
      expect(events[0].model).toBe('claude-3-5-sonnet');
    });
  });

  describe('Performance and Reliability', () => {
    it('should handle high-volume usage tracking', async () => {
      usageEmitter.setValkeyClient(null);

      const startTime = Date.now();
      const requestCount = 50;

      const requests = Array(requestCount).fill(null).map((_, index) =>
        request(server)
          .post('/test/anthropic')
          .send({ message: `Volume test ${index}` })
      );

      await Promise.all(requests);
      const endTime = Date.now();

      // Should complete within reasonable time
      expect(endTime - startTime).toBeLessThan(5000); // 5 seconds

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(requestCount);

      // All events should be valid
      events.forEach((event, index) => {
        expect(event).toMatchObject({
          authType: 'api_key',
          provider: 'unknown',
          model: 'claude-3-5-sonnet',
          statusCode: 200
        });
        expect(event.requestId).toBeDefined();
        expect(event.timestamp).toBeGreaterThan(0);
      });
    });

    it('should not impact response times significantly', async () => {
      usageEmitter.setValkeyClient(null);

      // Measure response time with usage tracking
      const startTime = Date.now();
      
      await request(server)
        .post('/test/anthropic')
        .send({ message: 'Performance test' });
      
      const responseTime = Date.now() - startTime;

      // Usage tracking should add minimal overhead
      expect(responseTime).toBeLessThan(100); // 100ms should be more than enough

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(1);
    });

    it('should handle memory queue size limits', async () => {
      usageEmitter.setValkeyClient(null);

      // Generate more events than the queue limit (assuming 1000).
      //
      // Two deliberate choices here, both of which exist to stop this test leaking
      // work into the tests that run after it. The emitter's memory queue is
      // singleton state shared by the whole file, so any request still in flight
      // when this test ends will push its event into whatever test runs next.
      //
      //  1. Requests are sent in bounded batches against the already-listening
      //     `server` rather than 1005 at once against `app`. The old version made
      //     supertest stand up an ephemeral server per request; at that concurrency
      //     the sockets intermittently produced "Parse Error: Expected HTTP/, RTSP/
      //     or ICE/", which is what made this suite fail roughly 1-in-8.
      //  2. `Promise.allSettled`, never `Promise.all`. `Promise.all` rejects on the
      //     first failure and hands control back with the other ~1000 requests still
      //     running, so a single bad socket aborted this test and then dumped its
      //     stragglers into the following tests' assertions.
      const totalRequests = 1005;
      const batchSize = 25;
      let delivered = 0;

      for (let sent = 0; sent < totalRequests; sent += batchSize) {
        const batch = Array(Math.min(batchSize, totalRequests - sent))
          .fill(null)
          .map((_, index) =>
            request(server)
              .post('/test/anthropic')
              .send({ message: `Overflow test ${sent + index}` })
          );

        const results = await Promise.allSettled(batch);
        delivered += results.filter(result => result.status === 'fulfilled').length;
      }

      // The queue must actually have been pushed past its limit, or the assertion
      // below would pass for the wrong reason.
      expect(delivered).toBeGreaterThan(1000);

      // Queue should respect size limit
      expect(usageEmitter.getQueueSize()).toBe(1000);
    });
  });

  describe('Authentication Scenarios', () => {
    it('should handle missing authentication gracefully', async () => {
      // Create endpoint without auth
      app.post('/test/no-auth', async (req: any, res) => {
        delete req.unifiedAuth;
        delete req.apiKey;
        delete req.awsCredential;
        
        const metrics = createUsageMetrics();
        await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 200);
        
        res.json({ success: true });
      });

      usageEmitter.setValkeyClient(null);

      await request(server)
        .post('/test/no-auth')
        .send({ message: 'No auth test' })
        .expect(200);

      // Should not generate usage events without auth
      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(0);
    });

    it('should handle legacy authentication fallback', async () => {
      app.post('/test/legacy-auth', async (req: any, res) => {
        delete req.unifiedAuth;
        req.apiKey = { id: 'legacy-api-key-id' };
        
        const metrics = createUsageMetrics();
        updateTokenCounts(metrics, 200, 300);
        await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 200);
        
        res.json({ success: true });
      });

      usageEmitter.setValkeyClient(null);

      await request(server)
        .post('/test/legacy-auth')
        .send({ message: 'Legacy auth test' })
        .expect(200);

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(1);
      
      expect(events[0]).toMatchObject({
        authType: 'api_key',
        credentialId: 'legacy-api-key-id',
        inputTokens: 200,
        outputTokens: 300
      });
    });

    it('should handle invalid authentication gracefully', async () => {
      app.post('/test/invalid-auth', async (req: any, res) => {
        req.unifiedAuth = { valid: false };
        
        const metrics = createUsageMetrics();
        await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 401);
        
        res.status(401).json({ error: 'Invalid auth' });
      });

      usageEmitter.setValkeyClient(null);

      await request(server)
        .post('/test/invalid-auth')
        .send({ message: 'Invalid auth test' })
        .expect(401);

      // Should not generate usage events with invalid auth
      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(0);
    });
  });
});