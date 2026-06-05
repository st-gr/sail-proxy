import { describe, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import { UsageEvent } from '../src/types/usage';
import { createUsageMetrics, updateTokenCounts, emitUsageEvent, extractAuthInfo } from '../src/utils/usageTracker';
import usageEmitter from '../src/services/usageEventEmitter';
import { isStandaloneMode } from '../src/config/unifiedAuthConfig';

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

// Mock Valkey client
const mockPublish = jest.fn();
// @ts-ignore - Jest mock typing issues
mockPublish.mockResolvedValue(undefined);

const mockValkeyClient: any = {
  publish: mockPublish,
  status: 'ready'
};

describe('Usage Tracking System', () => {
  const mockIsStandaloneMode = isStandaloneMode as jest.MockedFunction<typeof isStandaloneMode>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset standalone mode to non-standalone by default
    mockIsStandaloneMode.mockReturnValue(false);
    // Clear the usage emitter queue between tests
    usageEmitter.getAndClearMemoryQueue();
    usageEmitter.setValkeyClient(null);
  });

  afterEach(() => {
    // Clean up any timers or connections
  });

  describe('UsageTracker Utils', () => {
    describe('createUsageMetrics', () => {
      it('should create usage metrics with current timestamp', () => {
        const metrics = createUsageMetrics();
        
        expect(metrics).toHaveProperty('startTime');
        expect(metrics).toHaveProperty('inputTokens', 0);
        expect(metrics).toHaveProperty('outputTokens', 0);
        expect(typeof metrics.startTime).toBe('number');
        expect(metrics.startTime).toBeGreaterThan(0);
      });
    });

    describe('updateTokenCounts', () => {
      it('should update token counts in metrics', () => {
        const metrics = createUsageMetrics();
        
        updateTokenCounts(metrics, 100, 200);
        
        expect(metrics.inputTokens).toBe(100);
        expect(metrics.outputTokens).toBe(200);
      });

      it('should accumulate token counts on multiple updates', () => {
        const metrics = createUsageMetrics();
        
        updateTokenCounts(metrics, 100, 200);
        updateTokenCounts(metrics, 50, 75);
        
        expect(metrics.inputTokens).toBe(150);
        expect(metrics.outputTokens).toBe(275);
      });
    });

    describe('extractAuthInfo', () => {
      it('should extract API key auth info from unified auth', () => {
        const req = {
          unifiedAuth: {
            valid: true,
            authType: 'api_key' as const,
            data: { id: 'test-key-id' }
          }
        } as any;

        const authInfo = extractAuthInfo(req);

        expect(authInfo).toEqual({
          authType: 'api_key',
          credentialId: 'test-key-id'
        });
      });

      it('should extract AWS credential auth info from unified auth', () => {
        const req = {
          unifiedAuth: {
            valid: true,
            authType: 'aws_credential' as const,
            data: { keyId: 'test-aws-key' }
          }
        } as any;

        const authInfo = extractAuthInfo(req);

        expect(authInfo).toEqual({
          authType: 'aws_credential',
          credentialId: 'test-aws-key'
        });
      });

      it('should extract AWS credential auth info from unified auth with credentialId field', () => {
        const req = {
          unifiedAuth: {
            valid: true,
            authType: 'aws_credential' as const,
            data: { credentialId: 'actual-aws-credential-id' }
          }
        } as any;

        const authInfo = extractAuthInfo(req);

        expect(authInfo).toEqual({
          authType: 'aws_credential',
          credentialId: 'actual-aws-credential-id'
        });
      });

      it('should fallback to legacy API key auth', () => {
        const req = {
          apiKey: { id: 'legacy-key-id' }
        } as any;

        const authInfo = extractAuthInfo(req);

        expect(authInfo).toEqual({
          authType: 'api_key',
          credentialId: 'legacy-key-id'
        });
      });

      it('should fallback to legacy AWS credential auth', () => {
        const req = {
          awsCredential: { accessKeyId: 'legacy-aws-key' }
        } as any;

        const authInfo = extractAuthInfo(req);

        expect(authInfo).toEqual({
          authType: 'aws_credential',
          credentialId: 'legacy-aws-key'
        });
      });

      it('should return null when no auth info available', () => {
        const req = {} as any;

        const authInfo = extractAuthInfo(req);

        expect(authInfo).toBeNull();
      });

      it('should handle invalid auth gracefully', () => {
        const req = {
          unifiedAuth: { valid: false }
        } as any;

        const authInfo = extractAuthInfo(req);

        expect(authInfo).toBeNull();
      });
    });

    describe('emitUsageEvent', () => {
      it('should emit usage event with correct data', async () => {
        const req = {
          debugRequestId: 'test-request-123',
          unifiedAuth: {
            valid: true,
            authType: 'api_key' as const,
            data: { id: 'test-key-id' }
          }
        } as any;

        const metrics = createUsageMetrics();
        updateTokenCounts(metrics, 150, 250);

        // Mock the emit function
        const emitSpy = jest.spyOn(usageEmitter, 'emit').mockResolvedValue();

        await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 200);

        expect(emitSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            requestId: 'test-request-123',
            authType: 'api_key',
            credentialId: 'test-key-id',
            provider: 'unknown',
            model: 'claude-3-5-sonnet',
            inputTokens: 150,
            outputTokens: 250,
            statusCode: 200,
            timestamp: expect.any(Number),
            responseTime: expect.any(Number)
          })
        );

        emitSpy.mockRestore();
      });

      it('should not emit when no auth info available', async () => {
        const req = {} as any;
        const metrics = createUsageMetrics();

        const emitSpy = jest.spyOn(usageEmitter, 'emit').mockResolvedValue();

        await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 200);

        expect(emitSpy).not.toHaveBeenCalled();

        emitSpy.mockRestore();
      });

      it('should handle errors gracefully', async () => {
        const req = {
          debugRequestId: 'test-request-123',
          unifiedAuth: {
            valid: true,
            authType: 'api_key' as const,
            data: { id: 'test-key-id' }
          }
        } as any;

        const metrics = createUsageMetrics();
        const emitSpy = jest.spyOn(usageEmitter, 'emit').mockRejectedValue(new Error('Test error'));

        // Should not throw
        await expect(emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 200))
          .resolves.toBeUndefined();

        emitSpy.mockRestore();
      });

      describe('Standalone Mode', () => {
        it('should not emit usage events when in standalone mode', async () => {
          // Enable standalone mode
          mockIsStandaloneMode.mockReturnValue(true);

          const req = {
            debugRequestId: 'standalone-test-123',
            unifiedAuth: {
              valid: true,
              authType: 'api_key' as const,
              data: { id: 'test-key-id' }
            }
          } as any;

          const metrics = createUsageMetrics();
          updateTokenCounts(metrics, 150, 250);

          const emitSpy = jest.spyOn(usageEmitter, 'emit').mockResolvedValue();

          await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 200);

          // Should not call emit when in standalone mode
          expect(emitSpy).not.toHaveBeenCalled();

          emitSpy.mockRestore();
        });

        it('should emit usage events when not in standalone mode', async () => {
          // Explicitly set non-standalone mode (default, but make it clear)
          mockIsStandaloneMode.mockReturnValue(false);

          const req = {
            debugRequestId: 'non-standalone-test-123',
            unifiedAuth: {
              valid: true,
              authType: 'api_key' as const,
              data: { id: 'test-key-id' }
            }
          } as any;

          const metrics = createUsageMetrics();
          updateTokenCounts(metrics, 150, 250);

          const emitSpy = jest.spyOn(usageEmitter, 'emit').mockResolvedValue();

          await emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 200);

          // Should call emit when not in standalone mode
          expect(emitSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              requestId: 'non-standalone-test-123',
              authType: 'api_key',
              credentialId: 'test-key-id',
              model: 'claude-3-5-sonnet',
              inputTokens: 150,
              outputTokens: 250,
              statusCode: 200
            })
          );

          emitSpy.mockRestore();
        });
      });
    });
  });

  describe('UsageEventEmitter', () => {
    describe('emit', () => {
      it('should publish to Valkey when available', async () => {
        usageEmitter.setValkeyClient(mockValkeyClient);

        const event: UsageEvent = {
          requestId: 'test-123',
          timestamp: Math.floor(Date.now() / 1000),
          authType: 'api_key',
          credentialId: 'key-123',
          provider: 'unknown',
          model: 'claude-3-5-sonnet',
          inputTokens: 100,
          outputTokens: 200,
          responseTime: 1500,
          statusCode: 200
        };

        await usageEmitter.emit(event);

        expect(mockValkeyClient.publish).toHaveBeenCalledWith(
          'usage-events',
          JSON.stringify(event)
        );
      });

      it('should fallback to memory queue when Valkey fails', async () => {
        const failingPublish = jest.fn();
        // @ts-ignore - Jest mock typing issues
        failingPublish.mockRejectedValue(new Error('Valkey error'));
        
        const failingValkeyClient: any = {
          ...mockValkeyClient,
          publish: failingPublish
        };

        usageEmitter.setValkeyClient(failingValkeyClient);

        const event: UsageEvent = {
          requestId: 'test-123',
          timestamp: Math.floor(Date.now() / 1000),
          authType: 'api_key',
          credentialId: 'key-123',
          provider: 'unknown',
          model: 'claude-3-5-sonnet',
          inputTokens: 100,
          outputTokens: 200,
          responseTime: 1500,
          statusCode: 200
        };

        await usageEmitter.emit(event);

        expect(usageEmitter.getQueueSize()).toBe(1);
        
        const queuedEvents = usageEmitter.getAndClearMemoryQueue();
        expect(queuedEvents).toHaveLength(1);
        expect(queuedEvents[0]).toEqual(event);
      });

      it('should use memory queue when Valkey not available', async () => {
        usageEmitter.setValkeyClient(null);

        const event: UsageEvent = {
          requestId: 'test-123',
          timestamp: Math.floor(Date.now() / 1000),
          authType: 'aws_credential',
          credentialId: 'aws-key-123',
          provider: 'unknown',
          model: 'claude-3-5-haiku',
          inputTokens: 50,
          outputTokens: 100,
          responseTime: 800,
          statusCode: 200
        };

        await usageEmitter.emit(event);

        expect(usageEmitter.getQueueSize()).toBe(1);
        
        const queuedEvents = usageEmitter.getAndClearMemoryQueue();
        expect(queuedEvents).toHaveLength(1);
        expect(queuedEvents[0]).toEqual(event);
      });

      it('should handle memory queue size limit', async () => {
        usageEmitter.setValkeyClient(null);

        // Fill queue beyond limit (assuming 1000 limit)
        for (let i = 0; i < 1002; i++) {
          const event: UsageEvent = {
            requestId: `test-${i}`,
            timestamp: Math.floor(Date.now() / 1000),
            authType: 'api_key',
            credentialId: 'key-123',
            provider: 'unknown',
            model: 'claude-3-5-sonnet',
            inputTokens: 100,
            outputTokens: 200,
            responseTime: 1500,
            statusCode: 200
          };

          await usageEmitter.emit(event);
        }

        // Should not exceed queue size limit
        expect(usageEmitter.getQueueSize()).toBeLessThanOrEqual(1000);
      });

      describe('Standalone Mode', () => {
        it('should not emit to Valkey or memory queue when in standalone mode', async () => {
          // Enable standalone mode
          mockIsStandaloneMode.mockReturnValue(true);
          
          usageEmitter.setValkeyClient(mockValkeyClient);

          const event: UsageEvent = {
            requestId: 'standalone-test-123',
            timestamp: Math.floor(Date.now() / 1000),
            authType: 'api_key',
            credentialId: 'key-123',
            provider: 'unknown',
            model: 'claude-3-5-sonnet',
            inputTokens: 100,
            outputTokens: 200,
            responseTime: 1500,
            statusCode: 200
          };

          await usageEmitter.emit(event);

          // Should not publish to Valkey
          expect(mockValkeyClient.publish).not.toHaveBeenCalled();
          
          // Should not add to memory queue
          expect(usageEmitter.getQueueSize()).toBe(0);
        });

        it('should emit to Valkey when not in standalone mode', async () => {
          // Ensure non-standalone mode
          mockIsStandaloneMode.mockReturnValue(false);
          
          usageEmitter.setValkeyClient(mockValkeyClient);

          const event: UsageEvent = {
            requestId: 'non-standalone-test-123',
            timestamp: Math.floor(Date.now() / 1000),
            authType: 'api_key',
            credentialId: 'key-123',
            provider: 'unknown',
            model: 'claude-3-5-sonnet',
            inputTokens: 100,
            outputTokens: 200,
            responseTime: 1500,
            statusCode: 200
          };

          await usageEmitter.emit(event);

          // Should publish to Valkey
          expect(mockValkeyClient.publish).toHaveBeenCalledWith(
            'usage-events',
            JSON.stringify(event)
          );
        });

        it('should emit to memory queue when not in standalone mode and Valkey unavailable', async () => {
          // Ensure non-standalone mode
          mockIsStandaloneMode.mockReturnValue(false);
          
          usageEmitter.setValkeyClient(null);

          const event: UsageEvent = {
            requestId: 'non-standalone-memory-test-123',
            timestamp: Math.floor(Date.now() / 1000),
            authType: 'api_key',
            credentialId: 'key-123',
            provider: 'unknown',
            model: 'claude-3-5-sonnet',
            inputTokens: 100,
            outputTokens: 200,
            responseTime: 1500,
            statusCode: 200
          };

          await usageEmitter.emit(event);

          // Should add to memory queue
          expect(usageEmitter.getQueueSize()).toBe(1);
          
          const queuedEvents = usageEmitter.getAndClearMemoryQueue();
          expect(queuedEvents).toHaveLength(1);
          expect(queuedEvents[0]).toEqual(event);
        });
      });
    });

    describe('getAndClearMemoryQueue', () => {
      it('should return and clear queued events', async () => {
        usageEmitter.setValkeyClient(null);

        const events: UsageEvent[] = [
          {
            requestId: 'test-1',
            timestamp: Math.floor(Date.now() / 1000),
            authType: 'api_key',
            credentialId: 'key-1',
            provider: 'unknown',
            model: 'claude-3-5-sonnet',
            inputTokens: 100,
            outputTokens: 200,
            responseTime: 1500,
            statusCode: 200
          },
          {
            requestId: 'test-2',
            timestamp: Math.floor(Date.now() / 1000),
            authType: 'aws_credential',
            credentialId: 'aws-key-1',
            provider: 'unknown',
            model: 'claude-3-5-haiku',
            inputTokens: 50,
            outputTokens: 100,
            responseTime: 800,
            statusCode: 200
          }
        ];

        for (const event of events) {
          await usageEmitter.emit(event);
        }

        expect(usageEmitter.getQueueSize()).toBe(2);

        const retrievedEvents = usageEmitter.getAndClearMemoryQueue();
        
        expect(retrievedEvents).toHaveLength(2);
        expect(retrievedEvents).toEqual(events);
        expect(usageEmitter.getQueueSize()).toBe(0);
      });
    });

    describe('flushToAdminService', () => {
      it('should skip flush when Valkey is enabled', async () => {
        // Start with no Valkey to add events to memory queue first
        usageEmitter.setValkeyClient(null);
        await usageEmitter.emit({
          requestId: 'test-1',
          timestamp: Math.floor(Date.now() / 1000),
          authType: 'api_key',
          credentialId: 'key-1',
          provider: 'unknown',
          model: 'claude-3-5-sonnet',
          inputTokens: 100,
          outputTokens: 200,
          responseTime: 1500,
          statusCode: 200
        });

        // Verify event is in memory queue
        expect(usageEmitter.getQueueSize()).toBe(1);

        // Now set Valkey as enabled - this should cause flush to skip
        usageEmitter.setValkeyClient(mockValkeyClient);

        await usageEmitter.flushToAdminService();

        // Events should still be in memory queue since Valkey is enabled (flush skipped)
        expect(usageEmitter.getQueueSize()).toBe(1);
      });

      it('should skip flush when no events in queue', async () => {
        usageEmitter.setValkeyClient(null);

        await usageEmitter.flushToAdminService();

        // Should complete without error
        expect(usageEmitter.getQueueSize()).toBe(0);
      });
    });
  });

  describe('Integration Tests', () => {
    it('should handle complete flow from request to event emission', async () => {
      // Set up memory queue mode
      usageEmitter.setValkeyClient(null);

      const req = {
        debugRequestId: 'integration-test-123',
        unifiedAuth: {
          valid: true,
          authType: 'api_key' as const,
          data: { id: 'integration-key-id' }
        }
      } as any;

      const metrics = createUsageMetrics();
      updateTokenCounts(metrics, 500, 750);

      // Add small delay to ensure responseTime > 0
      await new Promise(resolve => setTimeout(resolve, 10));

      await emitUsageEvent(req, metrics, 'claude-3-5-sonnet-20241022', 200);

      expect(usageEmitter.getQueueSize()).toBe(1);

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(1);
      
      const event = events[0];
      expect(event).toMatchObject({
        requestId: 'integration-test-123',
        authType: 'api_key',
        credentialId: 'integration-key-id',
        provider: 'unknown',
        model: 'claude-3-5-sonnet-20241022',
        inputTokens: 500,
        outputTokens: 750,
        statusCode: 200
      });

      expect(event.timestamp).toBeGreaterThan(0);
      expect(event.responseTime).toBeGreaterThan(0);
    });

    it('should handle error cases gracefully', async () => {
      const req = {
        debugRequestId: 'error-test-123',
        unifiedAuth: {
          valid: true,
          authType: 'api_key' as const,
          data: { id: 'error-key-id' }
        }
      } as any;

      const metrics = createUsageMetrics();

      // Should not throw even with error status
      await expect(emitUsageEvent(req, metrics, 'claude-3-5-sonnet', 500))
        .resolves.toBeUndefined();

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(1);
      expect(events[0].statusCode).toBe(500);
    });

    it('should handle various auth types and providers', async () => {
      usageEmitter.setValkeyClient(null);

      const testCases = [
        {
          authType: 'api_key' as const,
          provider: 'unknown',
          model: 'claude-3-5-sonnet'
        },
        {
          authType: 'aws_credential' as const,
          provider: 'unknown',
          model: 'claude-3-5-haiku'
        },
        {
          authType: 'api_key' as const,
          provider: 'unknown',
          model: 'gpt-4o'
        }
      ];

      for (const testCase of testCases) {
        const req = {
          debugRequestId: `test-${testCase.authType}-${testCase.provider}`,
          unifiedAuth: {
            valid: true,
            authType: testCase.authType,
            data: { id: `${testCase.authType}-id` }
          }
        } as any;

        const metrics = createUsageMetrics();
        updateTokenCounts(metrics, 100, 200);

        await emitUsageEvent(req, metrics, testCase.model, 200);
      }

      const events = usageEmitter.getAndClearMemoryQueue();
      expect(events).toHaveLength(testCases.length);

      events.forEach((event, index) => {
        expect(event.authType).toBe(testCases[index].authType);
        expect(event.provider).toBe(testCases[index].provider);
        expect(event.model).toBe(testCases[index].model);
      });
    });
  });
});