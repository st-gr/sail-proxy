// Test setup file for Admin service
import { getAdminServiceUrl, getGatewayUrl } from '@libs/test-utils';

// Increase timeout for CAP operations
jest.setTimeout(30000);

// Global test setup
beforeAll(() => {
  // Set up test environment variables
  process.env.NODE_ENV = 'test';
  
  // Set service URLs for integration tests
  process.env.ADMIN_SERVICE_URL = process.env.ADMIN_SERVICE_URL || getAdminServiceUrl();
  process.env.GATEWAY_URL = process.env.GATEWAY_URL || getGatewayUrl();
});

// Mock console methods to reduce test noise
global.console = {
  ...console,
  // Uncomment to suppress console outputs during tests
  // log: jest.fn(),
  // debug: jest.fn(),
  // info: jest.fn(),
  // warn: jest.fn(),
  error: console.error, // Keep errors visible
};

// No global mocks here to avoid circular dependencies