/**
 * advancedAwsDebug is invoked from awsSigV4Auth with the raw secretAccessKey
 * (for HMAC-derivation debugging) and the raw request headers (which may
 * carry Authorization / x-api-key). None of that may reach the logger, even
 * though this whole module only runs when DEBUG-style tracing is on.
 *
 * @see ../src/middlewares/advancedAwsDebug.ts
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

import {
  analyzeRequest,
  performComprehensiveAnalysis,
  logSignatureVerificationFailure,
} from '../src/middlewares/advancedAwsDebug';

const FAKE_SECRET = 'FAKEsecretACCESSkey1234567890FAKEsecret';
const FAKE_STORED_SECRET = 'FAKEsecretACCESSkey1234567890FAKEstore';
const FAKE_BEARER = 'sk-test-FAKE-BEARER-TOKEN-abcdef123456';
const FAKE_ACCESS_KEY_ID = 'AKIAFAKE1234567890AB';

const authInfo = {
  accessKeyId: FAKE_ACCESS_KEY_ID,
  date: '20240101',
  region: 'us-east-1',
  service: 'bedrock',
  signedHeaders: ['host', 'x-amz-date', 'authorization'],
  signature: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
};

function makeReq() {
  return {
    method: 'POST',
    originalUrl: '/aws-bedrock/model/foo/invoke',
    body: {},
    headers: {
      host: 'localhost:3000',
      'x-amz-date': '20240101T000000Z',
      'x-amz-content-sha256': 'abc',
      authorization: `AWS4-HMAC-SHA256 Credential=${FAKE_ACCESS_KEY_ID}/20240101/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=deadbeef`,
      'x-api-key': FAKE_BEARER,
    },
  };
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

function expectNoLeak(...secrets: string[]) {
  const strings = loggedStrings();
  for (const secret of secrets) {
    for (let start = 0; start + 8 <= secret.length; start++) {
      const chunk = secret.slice(start, start + 8);
      expect(strings.some((s) => s.includes(chunk))).toBe(false);
    }
  }
}

describe('advancedAwsDebug never logs secrets, even in verbose debug output', () => {
  beforeEach(() => {
    loggerCalls.trace.mockClear();
    loggerCalls.debug.mockClear();
    loggerCalls.error.mockClear();
    loggerCalls.warn.mockClear();
    loggerCalls.info.mockClear();
  });

  it('analyzeRequest never leaks the Authorization or x-api-key header values', () => {
    const req = makeReq();
    const url = new URL(req.originalUrl, 'http://localhost:3000');
    analyzeRequest(req, authInfo, url, 'payloadhash', 'GET\n/\n\nhost:localhost\n\nhost\npayloadhash', 'expectedsig');

    expectNoLeak(FAKE_BEARER);
    // The raw Authorization header value embeds the access key ID; must not leak either.
    expectNoLeak(FAKE_ACCESS_KEY_ID);
  });

  it('performComprehensiveAnalysis never leaks the secret access key, in plain or hex form', () => {
    const credential = {
      id: 'cred-1',
      accessKeyId: FAKE_ACCESS_KEY_ID,
      reconstructedSecret: FAKE_STORED_SECRET,
      userId: 'user-1',
      createdAt: new Date(),
      isActive: true,
    };

    performComprehensiveAnalysis(
      {},
      authInfo,
      FAKE_SECRET,
      credential,
      'GET\n/\n\nhost:localhost\n\nhost\npayloadhash',
      'AWS4-HMAC-SHA256\n20240101T000000Z\nscope\nhash',
      'expectedsig'
    );

    expectNoLeak(FAKE_SECRET, FAKE_STORED_SECRET);
    // Not just the plain secret - the hex encoding is trivially reversible too.
    const secretHex = Buffer.from(FAKE_SECRET, 'utf8').toString('hex');
    const storedHex = Buffer.from(FAKE_STORED_SECRET, 'utf8').toString('hex');
    const strings = loggedStrings();
    expect(strings.some((s) => s.includes(secretHex))).toBe(false);
    expect(strings.some((s) => s.includes(storedHex))).toBe(false);
  });

  it('logSignatureVerificationFailure never leaks the Authorization or x-api-key header values', () => {
    const req = makeReq();
    const url = new URL(req.originalUrl, 'http://localhost:3000');
    logSignatureVerificationFailure(
      req,
      authInfo,
      url,
      'payloadhash',
      'GET\n/\n\nhost:localhost\n\nhost\npayloadhash',
      'AWS4-HMAC-SHA256\n20240101T000000Z\nscope\nhash',
      'expectedsig'
    );

    expectNoLeak(FAKE_BEARER, FAKE_ACCESS_KEY_ID);
  });
});
