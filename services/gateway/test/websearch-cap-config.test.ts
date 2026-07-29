import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import { resolveMaxWebSearches, DEFAULT_MAX_WEB_SEARCHES } from '../src/plugins/webSearch/searchCap';
import configService from '../src/services/configService';

describe('resolveMaxWebSearches', () => {
  it('accepts an in-range integer', () => {
    expect(resolveMaxWebSearches(1)).toBe(1);
    expect(resolveMaxWebSearches(5)).toBe(5);
    expect(resolveMaxWebSearches(10)).toBe(10);
  });

  it('falls back to the default rather than disabling the bound', () => {
    for (const bad of [0, -1, 11, 99, 1.5, 'many', null, undefined, {}, NaN, Infinity]) {
      expect(resolveMaxWebSearches(bad as any)).toBe(DEFAULT_MAX_WEB_SEARCHES);
    }
  });

  it('defaults to 3', () => {
    expect(DEFAULT_MAX_WEB_SEARCHES).toBe(3);
  });
});

describe('configService.getWebSearchMaxSearches', () => {
  it('resolves the value shipped in api_config.json', () => {
    expect(configService.getWebSearchMaxSearches()).toBe(3);
  });
});
