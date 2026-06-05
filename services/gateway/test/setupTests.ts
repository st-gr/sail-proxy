// Test setup file
import { jest } from '@jest/globals';
import { randomBytes } from 'crypto';
import { getAdminServiceUrl, getGatewayUrl } from '@libs/test-utils';

// Global test setup
beforeAll(() => {
  // Set up test environment variables
  process.env.NODE_ENV = 'test';
  process.env.VALKEY_URL = 'redis://localhost:6379';
  // Generate a random validation token secret for tests to avoid hardcoding
  process.env.VALIDATION_TOKEN_SECRET = randomBytes(32).toString('hex');
  
  // Set service URLs for integration tests
  process.env.ADMIN_SERVICE_URL = process.env.ADMIN_SERVICE_URL || getAdminServiceUrl();
  process.env.GATEWAY_URL = process.env.GATEWAY_URL || getGatewayUrl();
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

// Mock console methods in test environment
global.console = {
  ...console,
  // Uncomment below to suppress console output during tests
  // log: jest.fn(),
  // debug: jest.fn(),
  // info: jest.fn(),
  // warn: jest.fn(),
  // error: jest.fn(),
};