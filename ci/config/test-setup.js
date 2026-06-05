/**
 * Test setup for CI environment
 */

// Increase test timeout for CI
jest.setTimeout(60000);

// Set CI-specific environment variables
process.env.NODE_ENV = 'test';
process.env.CI = 'true';

// Mock console methods for cleaner test output in CI
const originalConsole = { ...console };

beforeAll(() => {
  if (process.env.CI === 'true') {
    // Suppress debug logs in CI unless explicitly enabled
    if (!process.env.DEBUG) {
      console.log = jest.fn();
      console.debug = jest.fn();
    }
    
    // Keep error and warning logs
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
  }
});

afterAll(() => {
  // Restore console methods
  Object.assign(console, originalConsole);
});

// Global test cleanup
afterEach(() => {
  // Clean up any timers or async operations
  jest.clearAllTimers();
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown for tests
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});