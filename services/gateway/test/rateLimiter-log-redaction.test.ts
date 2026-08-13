/**
 * rateLimiter must never write the raw bucket identifier (API key or AWS
 * access key ID) to the logger. The bucket key is still built from the raw
 * identifier for in-memory Map lookups — only the *logged* string changes,
 * to a short non-reversible label (hash-of-identifier + model).
 *
 * @see ../src/middlewares/rateLimiter.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const loggerDebug = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: (...args: any[]) => loggerDebug(...args),
    trace: jest.fn(),
  }),
}));

import rateLimiter from '../src/middlewares/rateLimiter';

const FAKE_KEY = 'sk-test-SECRET-VALUE-123';

/** Everything ever handed to logger.debug this run, flattened to strings. */
function loggedStrings(): string[] {
  return loggerDebug.mock.calls
    .flat()
    .filter((arg): arg is string => typeof arg === 'string');
}

function makeRes() {
  const finishHandlers: Array<() => void> = [];
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    on: (event: string, cb: () => void) => {
      if (event === 'finish') finishHandlers.push(cb);
    },
    triggerFinish: () => finishHandlers.forEach((cb) => cb()),
  } as any;
}

describe('rateLimiter never logs the raw identifier', () => {
  beforeEach(() => {
    loggerDebug.mockClear();
  });

  it('logs only a label, never the raw key, on the counted (finish) path', () => {
    const req: any = {
      apiKey: { key: FAKE_KEY },
      body: { model: 'gpt-4' },
    };
    const res = makeRes();
    const next = jest.fn();

    rateLimiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res.triggerFinish();

    const strings = loggedStrings();
    expect(strings.some((s) => s.includes(FAKE_KEY))).toBe(false);
    expect(
      strings.some((s) => /counted against rate limit for [0-9a-f]{8}-gpt-4, new count:/.test(s))
    ).toBe(true);
  });

  it('logs only a label, never the raw key, on the bypassed (finish) path', () => {
    const req: any = {
      apiKey: { key: FAKE_KEY },
      body: { model: 'gpt-4' },
      bypassRateLimit: false,
    };
    const res = makeRes();
    const next = jest.fn();

    rateLimiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Simulate a downstream plugin flipping the bypass flag before the
    // response finishes — this is what routes execution into the
    // "bypassed rate limit" branch inside the res.on('finish') callback.
    req.bypassRateLimit = true;
    res.triggerFinish();

    const strings = loggedStrings();
    expect(strings.some((s) => s.includes(FAKE_KEY))).toBe(false);
    expect(
      strings.some((s) => /bypassed rate limit for [0-9a-f]{8}-gpt-4, not counted/.test(s))
    ).toBe(true);
  });
});
