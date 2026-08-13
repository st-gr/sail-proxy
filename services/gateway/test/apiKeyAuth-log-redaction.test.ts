/**
 * apiKeyAuth must never write a raw or partial API key to the logger, even
 * under DEBUG=true. Before the fix this middleware logged the full raw key
 * (GitHub Copilot branch), a "first 3 / last 3 chars" prefix+suffix, and a
 * list of registered-key prefixes in the same shape.
 *
 * @see ../src/middlewares/apiKeyAuth.ts
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

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

const mockValidateApiKey: any = jest.fn();
const mockListApiKeys: any = jest.fn();
jest.mock('../src/services/apiKeyService', () => ({
  __esModule: true,
  default: {
    validateApiKey: (...args: any[]) => mockValidateApiKey(...args),
    listApiKeys: (...args: any[]) => mockListApiKeys(...args),
  },
}));

jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (jest.fn() as any).mockResolvedValue(undefined) },
}));

import apiKeyAuth from '../src/middlewares/apiKeyAuth';

const FAKE_KEY = 'sk-test-FAKE-INVALID-KEY-1234567890';
const FAKE_REGISTERED_KEY = 'sk-test-FAKE-REGISTERED-9876543210';

/** Everything ever handed to any mocked logger method this run, flattened. */
function allLoggedValues(): any[] {
  return [
    ...loggerCalls.debug.mock.calls,
    ...loggerCalls.error.mock.calls,
    ...loggerCalls.warn.mock.calls,
    ...loggerCalls.info.mock.calls,
  ].flat();
}

function loggedStrings(): string[] {
  return allLoggedValues()
    .flatMap((v) => (typeof v === 'string' ? [v] : typeof v === 'object' && v ? [JSON.stringify(v)] : []));
}

function makeReq(overrides: Record<string, any> = {}) {
  const headers: Record<string, any> = {
    'x-api-key': FAKE_KEY,
    'user-agent': 'GitHubCopilot/1.0',
    ...overrides.headers,
  };
  return {
    headers,
    query: {},
    body: {},
    method: 'POST',
    originalUrl: '/v1/chat/completions',
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
    get: (name: string) => headers[name.toLowerCase()],
    ...overrides,
  } as any;
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
}

describe('apiKeyAuth never logs the raw or partial API key', () => {
  const originalDebug = process.env.DEBUG;

  beforeEach(() => {
    loggerCalls.debug.mockClear();
    loggerCalls.error.mockClear();
    loggerCalls.warn.mockClear();
    loggerCalls.info.mockClear();
    mockValidateApiKey.mockReset();
    mockListApiKeys.mockReset();
    process.env.DEBUG = 'true';
  });

  afterEach(() => {
    process.env.DEBUG = originalDebug;
  });

  it('never leaks the key (whole or any 8+ char substring) when an invalid key from GitHub Copilot is rejected', async () => {
    mockValidateApiKey.mockResolvedValue(null);
    mockListApiKeys.mockResolvedValue([
      { key: FAKE_REGISTERED_KEY, isActive: true, createdAt: new Date('2024-01-01') },
    ]);

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await apiKeyAuth(req, res, next);

    const strings = loggedStrings();
    for (const secret of [FAKE_KEY, FAKE_REGISTERED_KEY]) {
      for (let start = 0; start + 8 <= secret.length; start++) {
        const chunk = secret.slice(start, start + 8);
        expect(strings.some((s) => s.includes(chunk))).toBe(false);
      }
    }

    // The label must still show up, so the log line keeps its diagnostic value.
    expect(strings.some((s) => /[0-9a-f]{8}/.test(s))).toBe(true);
  });
});
