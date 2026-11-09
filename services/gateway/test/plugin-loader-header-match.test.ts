import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import { headerValueMatches } from '../src/services/pluginLoader';

describe('headerValueMatches', () => {
  it('matches a bare application/json', () => {
    expect(headerValueMatches('application/json', 'application/json')).toBe(true);
  });

  it('matches when the client appends a charset parameter', () => {
    expect(headerValueMatches('application/json; charset=utf-8', 'application/json')).toBe(true);
  });

  it('ignores parameter spacing and case', () => {
    expect(headerValueMatches('Application/JSON;charset=UTF-8', 'application/json')).toBe(true);
    expect(headerValueMatches('  application/json  ; x=1', 'application/json')).toBe(true);
  });

  it('does not match a different media type', () => {
    expect(headerValueMatches('text/plain', 'application/json')).toBe(false);
    expect(headerValueMatches('application/json-patch+json', 'application/json')).toBe(false);
    expect(headerValueMatches('application/jsonx', 'application/json')).toBe(false);
  });

  it('keeps exact-match semantics when the expected value itself has parameters', () => {
    expect(headerValueMatches('application/json; charset=utf-8', 'application/json; charset=utf-8')).toBe(true);
    expect(headerValueMatches('application/json', 'application/json; charset=utf-8')).toBe(false);
  });
});
