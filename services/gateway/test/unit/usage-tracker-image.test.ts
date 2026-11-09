import { describe, it, expect, jest } from '@jest/globals';
import { createUsageMetrics, updateTokenCounts } from '../../src/utils/usageTracker';

// Mock logger so updateTokenCounts' info-log call doesn't hit the real transport
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn()
  })
}));

describe('image token accumulation', () => {
  it('seeds imageInputTokens 0 and accumulates it', () => {
    const m = createUsageMetrics();
    expect(m.imageInputTokens).toBe(0);
    updateTokenCounts(m, 10, 5, 0, 0, 42);
    updateTokenCounts(m, 10, 5, 0, 0, 8);
    expect(m.imageInputTokens).toBe(50);
  });

  it('treats a missing image arg as 0', () => {
    const m = createUsageMetrics();
    updateTokenCounts(m, 10, 5);
    expect(m.imageInputTokens).toBe(0);
  });
});
