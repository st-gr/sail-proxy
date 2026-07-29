import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import configService from '../src/services/configService';

describe('configService.getNamespaceToolMode', () => {
  it('resolves the mode shipped in api_config.json', () => {
    expect(configService.getNamespaceToolMode()).toBe('flatten');
  });

  it('is reachable off the default export, which is how the plugin calls it', () => {
    expect(typeof configService.getNamespaceToolMode).toBe('function');
  });
});
