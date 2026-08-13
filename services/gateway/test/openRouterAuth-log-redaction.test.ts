/**
 * openRouterAuth must never write the raw API key (or a "first N chars"
 * prefix of it) to the logger.
 *
 * @see ../src/middlewares/openRouterAuth.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const loggerCalls = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() };
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...args: any[]) => loggerCalls.error(...args),
    warn: (...args: any[]) => loggerCalls.warn(...args),
    info: (...args: any[]) => loggerCalls.info(...args),
    debug: (...args: any[]) => loggerCalls.debug(...args),
    trace: jest.fn(),
  }),
}));

import openRouterAuth from '../src/middlewares/openRouterAuth';

const FAKE_KEY = 'sk-test-FAKE-OPENROUTER-KEY-1234567890';

function loggedStrings(): string[] {
  return [
    ...loggerCalls.debug.mock.calls,
    ...loggerCalls.error.mock.calls,
    ...loggerCalls.warn.mock.calls,
    ...loggerCalls.info.mock.calls,
  ]
    .flat()
    .filter((arg): arg is string => typeof arg === 'string');
}

describe('openRouterAuth never logs the raw or partial API key', () => {
  beforeEach(() => {
    loggerCalls.debug.mockClear();
    loggerCalls.error.mockClear();
    loggerCalls.warn.mockClear();
    loggerCalls.info.mockClear();
  });

  it('never leaks the key (whole or any 8+ char substring) when a key is provided', () => {
    const req: any = { headers: { 'x-api-key': FAKE_KEY }, originalUrl: '/openrouter/api/v1/chat/completions' };
    const res: any = {};
    const next = jest.fn();

    openRouterAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const strings = loggedStrings();
    for (let start = 0; start + 8 <= FAKE_KEY.length; start++) {
      const chunk = FAKE_KEY.slice(start, start + 8);
      expect(strings.some((s) => s.includes(chunk))).toBe(false);
    }
    expect(strings.some((s) => /API Key label: [0-9a-f]{8}/.test(s))).toBe(true);
  });
});
