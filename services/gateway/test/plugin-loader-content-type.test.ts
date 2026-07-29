import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  }),
}));

import { matchAll } from '../src/services/pluginLoader';

const reqWith = (contentType: string): any => ({ headers: { 'content-type': contentType }, body: {} });

describe('matchAll — header:contentTypeJson against the shipped config', () => {
  it('matches a charset-suffixed content type', () => {
    expect(matchAll(reqWith('application/json; charset=utf-8'), ['header:contentTypeJson'])).toBe(true);
  });

  it('still matches a bare content type', () => {
    expect(matchAll(reqWith('application/json'), ['header:contentTypeJson'])).toBe(true);
  });

  it('does not match a non-JSON content type', () => {
    expect(matchAll(reqWith('text/plain'), ['header:contentTypeJson'])).toBe(false);
  });
});
