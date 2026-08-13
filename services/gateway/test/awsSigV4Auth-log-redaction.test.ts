/**
 * awsSigV4Auth must never write the raw AWS access key ID to the logger.
 *
 * @see ../src/middlewares/awsSigV4Auth.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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

const mockFindAwsCredential: any = jest.fn();
const mockGetSecretForSignature: any = jest.fn();
jest.mock('../src/services/awsCredentialsService', () => ({
  __esModule: true,
  findAwsCredential: (...args: any[]) => mockFindAwsCredential(...args),
  getSecretForSignature: (...args: any[]) => mockGetSecretForSignature(...args),
}));

import awsSigV4Auth from '../src/middlewares/awsSigV4Auth';

const FAKE_ACCESS_KEY_ID = 'AKIAFAKE1234567890AB';

function authHeader(accessKeyId: string): string {
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20240101/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=deadbeef`;
}

function makeReq(accessKeyId: string) {
  return {
    headers: {
      authorization: authHeader(accessKeyId),
      'x-amz-date': '20240101T000000Z',
      host: 'localhost:3000',
    },
    method: 'POST',
    path: '/aws-bedrock/model/foo/invoke',
    originalUrl: '/aws-bedrock/model/foo/invoke',
    query: {},
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

function expectNoLeak(accessKeyId: string) {
  const strings = loggedStrings();
  for (let start = 0; start + 8 <= accessKeyId.length; start++) {
    const chunk = accessKeyId.slice(start, start + 8);
    expect(strings.some((s) => s.includes(chunk))).toBe(false);
  }
  expect(strings.some((s) => /[0-9a-f]{8}/.test(s))).toBe(true);
}

describe('awsSigV4Auth never logs the raw AWS access key ID', () => {
  beforeEach(() => {
    loggerCalls.trace.mockClear();
    loggerCalls.debug.mockClear();
    loggerCalls.error.mockClear();
    loggerCalls.warn.mockClear();
    loggerCalls.info.mockClear();
    mockFindAwsCredential.mockReset();
    mockGetSecretForSignature.mockReset();
  });

  it('never leaks the access key ID when the access key is not found', async () => {
    mockFindAwsCredential.mockResolvedValue(null);

    const req = makeReq(FAKE_ACCESS_KEY_ID);
    const res = makeRes();
    const next = jest.fn();

    await awsSigV4Auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expectNoLeak(FAKE_ACCESS_KEY_ID);
  });

  it('never leaks the access key ID when the secret cannot be retrieved', async () => {
    mockFindAwsCredential.mockResolvedValue({ id: 'cred-1', userId: 'user-1' });
    mockGetSecretForSignature.mockResolvedValue(null);

    const req = makeReq(FAKE_ACCESS_KEY_ID);
    const res = makeRes();
    const next = jest.fn();

    await awsSigV4Auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expectNoLeak(FAKE_ACCESS_KEY_ID);
  });
});
