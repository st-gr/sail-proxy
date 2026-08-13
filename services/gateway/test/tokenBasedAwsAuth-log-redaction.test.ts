/**
 * tokenBasedAwsAuth must never write the raw AWS access key ID to the
 * logger. This test drives the two branches reachable without a live admin
 * service: the unconditional "processing" trace right after header parsing,
 * and the "authentication failed" warning once validation comes back
 * invalid. The "cache hit" and "successfully authenticated" branches need a
 * full valid-credential round trip through the admin service and are
 * covered by a source-level check instead (see the last test below).
 *
 * @see ../src/middlewares/tokenBasedAwsAuth.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const loggerCalls = { trace: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() };
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: (...args: any[]) => loggerCalls.error(...args),
    warn: (...args: any[]) => loggerCalls.warn(...args),
    info: (...args: any[]) => loggerCalls.info(...args),
    debug: (...args: any[]) => loggerCalls.debug(...args),
    trace: (...args: any[]) => loggerCalls.trace(...args),
  }),
}));

jest.mock('../src/services/securityEventEmitter', () => ({
  __esModule: true,
  default: { emitFailedAuth: (jest.fn() as any).mockResolvedValue(undefined) },
}));

const mockValidateAwsCredential: any = jest.fn();
jest.mock('../src/services/unifiedAwsCredentialValidationService', () => ({
  __esModule: true,
  unifiedAwsCredentialValidationService: {
    validateAwsCredential: (...args: any[]) => mockValidateAwsCredential(...args),
  },
}));

import tokenBasedAwsAuth from '../src/middlewares/tokenBasedAwsAuth';

const FAKE_ACCESS_KEY_ID = 'AKIAFAKE1234567890AB';

function authHeader(accessKeyId: string): string {
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20240101/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=deadbeef`;
}

function makeReq() {
  return {
    headers: {
      authorization: authHeader(FAKE_ACCESS_KEY_ID),
      'x-amz-date': '20240101T000000Z',
      host: 'localhost:3000',
    },
    method: 'POST',
    path: '/aws-bedrock/model/foo/invoke',
    originalUrl: '/aws-bedrock/model/foo/invoke',
    query: {},
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
  } as any;
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
}

function loggedStrings(): string[] {
  return [
    ...loggerCalls.trace.mock.calls,
    ...loggerCalls.debug.mock.calls,
    ...loggerCalls.error.mock.calls,
    ...loggerCalls.warn.mock.calls,
    ...loggerCalls.info.mock.calls,
  ]
    .flat()
    .filter((arg): arg is string => typeof arg === 'string');
}

describe('tokenBasedAwsAuth never logs the raw AWS access key ID', () => {
  beforeEach(() => {
    loggerCalls.trace.mockClear();
    loggerCalls.debug.mockClear();
    loggerCalls.error.mockClear();
    loggerCalls.warn.mockClear();
    loggerCalls.info.mockClear();
    mockValidateAwsCredential.mockReset();
  });

  it('never leaks the access key ID across the processing + auth-failed path', async () => {
    mockValidateAwsCredential.mockResolvedValue({
      valid: false,
      auditInfo: { requestId: 'req-1', validationTime: 1, cacheHit: false },
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid AWS credentials' },
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await tokenBasedAwsAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);

    const strings = loggedStrings();
    // Sanity: both target log lines actually fired.
    expect(strings.some((s) => s.includes('Processing AWS SigV4 request'))).toBe(true);
    expect(strings.some((s) => s.includes('Authentication failed for'))).toBe(true);

    for (let start = 0; start + 8 <= FAKE_ACCESS_KEY_ID.length; start++) {
      const chunk = FAKE_ACCESS_KEY_ID.slice(start, start + 8);
      expect(strings.some((s) => s.includes(chunk))).toBe(false);
    }
  });

  // "Cache hit for access key" and "Successfully authenticated AWS request"
  // only fire after a full valid-credential round trip through the admin
  // service, which isn't practical to drive directly here — confirm at the
  // source level that both sites use the same redaction as the branches
  // exercised above.
  it('redacts the accessKeyId at the cache-hit and success log sites too', () => {
    const source = readFileSync(join(__dirname, '../src/middlewares/tokenBasedAwsAuth.ts'), 'utf8');
    expect(source).toMatch(/Cache hit for access key: \$\{secretLabel\(parsed\.accessKeyId\)\}/);
    expect(source).toMatch(/Successfully authenticated AWS request for \$\{secretLabel\(parsed\.accessKeyId\)\}/);
  });
});
