/**
 * Test utilities and helpers
 * Provides common testing utilities across the project
 */

export * from './port-utils';
export * from './test-config';
export * from './active-config-guard';

// Additional test utilities can be exported here
export const TestHelpers = {
  delay: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  
  waitForCondition: async (
    condition: () => boolean | Promise<boolean>,
    timeout: number = 5000,
    interval: number = 100
  ): Promise<boolean> => {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      if (await condition()) {
        return true;
      }
      await TestHelpers.delay(interval);
    }
    
    return false;
  }
};