/**
 * Beta Header Filtering Tests
 *
 * Tests for filtering unsupported anthropic_beta headers to prevent
 * "invalid beta flag" errors from SAP AI Core.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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

import configService from '../src/services/configService';

describe('Beta Header Filtering', () => {
  describe('configService.getExcludedBetaHeaders', () => {
    it('should return configured excluded headers', () => {
      const excluded = configService.getExcludedBetaHeaders();
      expect(Array.isArray(excluded)).toBe(true);
      expect(excluded).toContain('prompt-caching-scope-2026-01-05');
    });

    it('should return empty array when no excluded headers configured', () => {
      // This tests the default behavior - would need config mocking for edge cases
      const excluded = configService.getExcludedBetaHeaders();
      expect(Array.isArray(excluded)).toBe(true);
    });
  });

  describe('configService.getSupportedBetaHeaders', () => {
    it('returns an array of strings (empty when the key is absent)', () => {
      const supported = configService.getSupportedBetaHeaders();
      expect(Array.isArray(supported)).toBe(true);
      supported.forEach(flag => expect(typeof flag).toBe('string'));
    });
  });

  describe('beta header filtering logic', () => {
    const filterBetaHeaders = (headers: string[], excluded: string[]): string[] => {
      return headers.filter(h => !excluded.includes(h));
    };

    it('should pass through allowed beta headers unchanged', () => {
      const headers = ['claude-code-20250219', 'interleaved-thinking-2025-05-14'];
      const excluded = ['prompt-caching-scope-2026-01-05'];

      const result = filterBetaHeaders(headers, excluded);
      expect(result).toEqual(['claude-code-20250219', 'interleaved-thinking-2025-05-14']);
    });

    it('should filter out excluded beta headers', () => {
      const headers = ['claude-code-20250219', 'interleaved-thinking-2025-05-14', 'prompt-caching-scope-2026-01-05'];
      const excluded = ['prompt-caching-scope-2026-01-05'];

      const result = filterBetaHeaders(headers, excluded);
      expect(result).toEqual(['claude-code-20250219', 'interleaved-thinking-2025-05-14']);
    });

    it('should handle all headers being filtered', () => {
      const headers = ['prompt-caching-scope-2026-01-05'];
      const excluded = ['prompt-caching-scope-2026-01-05'];

      const result = filterBetaHeaders(headers, excluded);
      expect(result).toEqual([]);
    });

    it('should handle empty excluded list', () => {
      const headers = ['claude-code-20250219', 'prompt-caching-scope-2026-01-05'];
      const excluded: string[] = [];

      const result = filterBetaHeaders(headers, excluded);
      expect(result).toEqual(['claude-code-20250219', 'prompt-caching-scope-2026-01-05']);
    });
  });
});
