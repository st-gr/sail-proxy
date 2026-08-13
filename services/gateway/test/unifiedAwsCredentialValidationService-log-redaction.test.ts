/**
 * unifiedAwsCredentialValidationService must never write a raw AWS access
 * key ID to the logger. `validateAwsCredential()` logs a trace line
 * unconditionally before any branching, so that's the site this test
 * drives directly.
 *
 * @see ../src/services/unifiedAwsCredentialValidationService.ts
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// See unifiedApiKeyValidationService-log-redaction.test.ts for why this must
// be set before this file's SecureMetadataExchange-importing modules load.
process.env.VALIDATION_TOKEN_SECRET = process.env.VALIDATION_TOKEN_SECRET || 'x'.repeat(32);

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

jest.mock('../src/services/awsCredentialsService', () => ({
  __esModule: true,
  findAwsCredential: (jest.fn() as any).mockResolvedValue(null),
  getSecretForSignature: (jest.fn() as any).mockResolvedValue(null),
}));

// require(), not import: a static import is hoisted above the process.env
// assignment above, defeating the point of setting it first.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { unifiedAwsCredentialValidationService } = require('../src/services/unifiedAwsCredentialValidationService');

const FAKE_ACCESS_KEY_ID = 'AKIAFAKE1234567890AB';

function loggedValues(): any[] {
  return [
    ...loggerCalls.trace.mock.calls,
    ...loggerCalls.debug.mock.calls,
    ...loggerCalls.error.mock.calls,
    ...loggerCalls.warn.mock.calls,
    ...loggerCalls.info.mock.calls,
  ].flat();
}

function loggedStrings(): string[] {
  return loggedValues().flatMap((v) => (typeof v === 'string' ? [v] : typeof v === 'object' && v ? [JSON.stringify(v)] : []));
}

describe('unifiedAwsCredentialValidationService never logs the raw AWS access key ID', () => {
  beforeEach(() => {
    loggerCalls.trace.mockClear();
    loggerCalls.debug.mockClear();
    loggerCalls.error.mockClear();
    loggerCalls.warn.mockClear();
    loggerCalls.info.mockClear();
  });

  it('never leaks the access key ID (whole or any 8+ char substring) while validating', async () => {
    await unifiedAwsCredentialValidationService.validateAwsCredential({
      accessKeyId: FAKE_ACCESS_KEY_ID,
      signature: 'deadbeef',
      clientIp: '127.0.0.1',
      method: 'POST',
      endpoint: '/aws-bedrock/model/invoke',
    });

    const strings = loggedStrings();
    for (let start = 0; start + 8 <= FAKE_ACCESS_KEY_ID.length; start++) {
      const chunk = FAKE_ACCESS_KEY_ID.slice(start, start + 8);
      expect(strings.some((s) => s.includes(chunk))).toBe(false);
    }
    expect(strings.some((s) => /accessKeyLabel["\s:]*[0-9a-f]{8}/.test(s))).toBe(true);
  });
});
