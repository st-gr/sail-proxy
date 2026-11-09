// Test setup file
import { jest } from '@jest/globals';
import { randomBytes } from 'crypto';
import { getAdminServiceUrl, getGatewayUrl, pinEphemeralServersToLoopback } from '@libs/test-utils';

// Ephemeral test servers bind 127.0.0.1, where their clients dial (libs/test-utils/src/loopback-listen.ts).
pinEphemeralServersToLoopback();

// No test may hold the product S3 keys: a developer's services/gateway/.env can carry real AWS keys
// with no IAM limit. S3 tests inject their credentials into createS3Backend instead. Deleted now,
// and again around every test, because modules such as services/modelService.ts and
// services/sapAIService.ts call dotenv.config() when a test file imports them, which re-adds them.
const PRODUCT_S3_KEYS = ['FILE_SEARCH_S3_ACCESS_KEY_ID', 'FILE_SEARCH_S3_SECRET_ACCESS_KEY'];
const scrubProductS3Keys = () => { for (const name of PRODUCT_S3_KEYS) delete process.env[name]; };
scrubProductS3Keys();
beforeAll(scrubProductS3Keys);
beforeEach(scrubProductS3Keys);
afterEach(scrubProductS3Keys);

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