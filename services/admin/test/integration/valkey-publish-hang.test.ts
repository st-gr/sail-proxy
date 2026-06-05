/**
 * Test to isolate the Valkey publish hang during configuration activation
 */

import Valkey from 'iovalkey';

describe('Valkey Publish Hang Test', () => {
  let valkeyClient: Valkey;

  beforeAll(async () => {
    // Initialize exactly like the config service does
    const valkeyUrl = 'redis://localhost:6379';
    valkeyClient = new Valkey(valkeyUrl, {
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
      lazyConnect: true
    });
  });

  afterAll(async () => {
    if (valkeyClient) {
      await valkeyClient.quit();
    }
  });

  it('should connect to Valkey successfully', async () => {
    const response = await valkeyClient.ping();
    expect(response).toBe('PONG');
  });

  it('should publish a simple message without hanging', async () => {
    const testEvent = {
      eventType: 'config-activated',
      configId: 'test-id',
      configName: 'Test Config',
      version: '1.0.0',
      checksum: 'test-checksum',
      timestamp: new Date().toISOString()
    };

    const channel = 'sap-llm-gateway:config-activated';
    const message = JSON.stringify(testEvent);

    // This should complete within 2 seconds or timeout
    await expect(
      Promise.race([
        valkeyClient.publish(channel, message),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Publish timeout')), 2000)
        )
      ])
    ).resolves.toBeGreaterThanOrEqual(0); // Number of subscribers that received the message
  });

  it('should handle multiple rapid publishes', async () => {
    const promises = [];
    
    for (let i = 0; i < 5; i++) {
      const testEvent = {
        eventType: 'config-activated',
        configId: `test-id-${i}`,
        configName: `Test Config ${i}`,
        version: '1.0.0',
        checksum: `test-checksum-${i}`,
        timestamp: new Date().toISOString()
      };

      const channel = 'sap-llm-gateway:config-activated';
      const message = JSON.stringify(testEvent);

      promises.push(
        Promise.race([
          valkeyClient.publish(channel, message),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Publish ${i} timeout`)), 2000)
          )
        ])
      );
    }

    // All publishes should complete
    const results = await Promise.all(promises);
    expect(results).toHaveLength(5);
    results.forEach(result => expect(result).toBeGreaterThanOrEqual(0));
  });

  it('should test the exact activation sequence', async () => {
    // Simulate the exact sequence from activateConfiguration
    const configEvent = {
      eventType: 'config-activated' as const,
      configId: '7ec7b574-a7f4-4433-841a-9a6887db9f01',
      configName: 'Default Configuration',
      version: '2025.9.42202', 
      checksum: '00381bd9dc73159ba304baac7888d59ecec5bfd158eb3b846060154aac9dead8',
      timestamp: new Date().toISOString()
    };

    const channel = `sap-llm-gateway:${configEvent.eventType}`;
    const message = JSON.stringify(configEvent);

    console.log('Publishing to channel:', channel);
    console.log('Message size:', message.length);

    const startTime = Date.now();
    const result = await Promise.race([
      valkeyClient.publish(channel, message),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Activation publish timeout')), 5000)
      )
    ]);
    const endTime = Date.now();

    console.log(`Publish completed in ${endTime - startTime}ms, result:`, result);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});