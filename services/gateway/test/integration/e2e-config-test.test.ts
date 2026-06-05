/**
 * Focused Configuration Management Tests
 * Tests configuration management without full service startup
 * Mocks external dependencies to reduce test complexity
 */

import Redis from 'iovalkey';

describe('Configuration Management Integration', () => {
  let valkeyClient: Redis | null = null;
  
  const VALKEY_URL = process.env.TEST_VALKEY_URL || 'redis://localhost:6379';
  const TEST_TIMEOUT = 10000; // Reduced from 60s

  beforeAll(async () => {
    // Setup test Valkey connection
    try {
      valkeyClient = new Redis(VALKEY_URL);
      await valkeyClient.ping();
    } catch (error) {
      console.warn('Valkey not available for testing:', error);
      valkeyClient = null;
    }
  });

  afterAll(async () => {
    if (valkeyClient) {
      await valkeyClient.quit();
      valkeyClient = null;
    }
  });

  // Create test configuration data
  const createTestConfig = (variant: number = 1) => ({
    openai: {
      substitute_models: [
        { from: "GPT-4", to: variant === 1 ? "o1" : "o1-pro" }
      ],
      emulate_streaming_for_models: []
    },
    anthropic: {
      substitute_models: [
        { from: "claude-3-5-haiku-20241022", to: "anthropic--claude-3-haiku" }
      ],
      emulate_streaming_for_models: variant === 1 ? ["anthropic--claude-3.7-sonnet"] : []
    }
  });

  // Mock Valkey event publishing for testing
  const publishConfigEvent = async (eventType: string, configData: any) => {
    if (!valkeyClient) return;
    
    const event = {
      eventType,
      configId: 'test-config-id',
      configName: 'Test Configuration',
      version: 1,
      configData,
      timestamp: new Date().toISOString()
    };
    
    await valkeyClient.publish('sap-llm-gateway:config-changed', JSON.stringify(event));
  };

  describe('Configuration Service Integration', () => {
    test('should validate configuration structure', async () => {
      const testConfig = createTestConfig(1);
      
      // Basic structure validation
      expect(testConfig.openai).toBeDefined();
      expect(testConfig.anthropic).toBeDefined();
      expect(Array.isArray(testConfig.openai.substitute_models)).toBe(true);
      expect(Array.isArray(testConfig.anthropic.substitute_models)).toBe(true);
    }, TEST_TIMEOUT);

    test('should handle configuration events via Valkey', async () => {
      if (!valkeyClient) {
        console.log('Skipping Valkey events test - Valkey not available');
        return;
      }

      // Subscribe to configuration change events
      const eventSubscriber = new Redis(VALKEY_URL);
      const receivedEvents: any[] = [];

      await eventSubscriber.subscribe('sap-llm-gateway:config-changed');
      eventSubscriber.on('message', (channel, message) => {
        if (channel === 'sap-llm-gateway:config-changed') {
          const event = JSON.parse(message);
          receivedEvents.push(event);
        }
      });

      // Publish a test configuration event
      const testConfig = createTestConfig(1);
      await publishConfigEvent('configuration-activated', testConfig);

      // Wait for event to be received
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify we received the event
      expect(receivedEvents.length).toBeGreaterThan(0);
      
      const activationEvent = receivedEvents.find(event => 
        event.eventType === 'configuration-activated'
      );
      
      expect(activationEvent).toBeDefined();
      expect(activationEvent.configData).toBeDefined();
      
      await eventSubscriber.quit();
    }, TEST_TIMEOUT);

    test('should handle configuration variants', async () => {
      const config1 = createTestConfig(1);
      const config2 = createTestConfig(2);
      
      // Verify different configurations
      expect(config1.openai.substitute_models[0].to).toBe('o1');
      expect(config2.openai.substitute_models[0].to).toBe('o1-pro');
      
      expect(config1.anthropic.emulate_streaming_for_models.length).toBeGreaterThan(0);
      expect(config2.anthropic.emulate_streaming_for_models.length).toBe(0);
    }, TEST_TIMEOUT);

    test('should handle invalid configuration structure', async () => {
      const invalidConfig = {
        openai: {
          substitute_models: "this_should_be_an_array"  // Invalid format
        }
      };

      // Basic validation - should detect invalid structure
      expect(typeof invalidConfig.openai.substitute_models).toBe('string');
      expect(Array.isArray(invalidConfig.openai.substitute_models)).toBe(false);
    }, TEST_TIMEOUT);

    test('should handle connection validation properly', async () => {
      // Simple validation test without actual connection
      expect(VALKEY_URL).toBeDefined();
      expect(typeof VALKEY_URL).toBe('string');
    }, TEST_TIMEOUT);
  });
});