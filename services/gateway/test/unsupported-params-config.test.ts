/**
 * Verifies the shipped api_config.json wires provider-level unsupported params,
 * and that the layered resolution (per-model overrides provider) works through
 * the real configService accessor.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import configService from '../src/services/configService';

describe('configService.getUnsupportedParams', () => {
  it('resolves the shipped perplexity provider block', () => {
    const params = configService.getUnsupportedParams('perplexity');
    expect(params).toContain('tools');          // the reported SAP 400
    expect(params).toContain('response_format'); // the next one waiting to happen
  });

  it('returns [] for providers with no unsupported params configured', () => {
    expect(configService.getUnsupportedParams('anthropic')).toEqual([]);
    expect(configService.getUnsupportedParams('openai')).toEqual([]);
  });

  it('returns [] for an unknown provider or when no provider is given', () => {
    expect(configService.getUnsupportedParams('does-not-exist')).toEqual([]);
    expect(configService.getUnsupportedParams()).toEqual([]);
  });

  it('a model with no override inherits the provider list', () => {
    expect(configService.getUnsupportedParams('perplexity', 'sonar')).toContain('tools');
  });
});
