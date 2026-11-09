/**
 * awsApiKeysController must never write the raw AWS access key ID to the
 * logger when a credential is revoked.
 *
 * @see ../src/controllers/awsApiKeysController.ts
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

const mockRevokeAwsCredentials: any = jest.fn();
jest.mock('../src/services/awsCredentialsService', () => ({
  __esModule: true,
  createAwsCredentials: jest.fn(),
  listAwsCredentials: jest.fn(),
  revokeAwsCredentials: (...args: any[]) => mockRevokeAwsCredentials(...args),
  findAwsCredentialByAccessKeyId: jest.fn(),
  setAwsCredentialKeys: jest.fn(),
}));

import { revokeAwsCredentials } from '../src/controllers/awsApiKeysController';

const FAKE_ACCESS_KEY_ID = 'AKIAFAKE1234567890AB';

function loggedStrings(): string[] {
  return [...loggerCalls.debug.mock.calls, ...loggerCalls.error.mock.calls, ...loggerCalls.warn.mock.calls, ...loggerCalls.info.mock.calls]
    .flat()
    .filter((arg): arg is string => typeof arg === 'string');
}

describe('awsApiKeysController never logs the raw AWS access key ID', () => {
  beforeEach(() => {
    loggerCalls.debug.mockClear();
    loggerCalls.error.mockClear();
    loggerCalls.warn.mockClear();
    loggerCalls.info.mockClear();
    mockRevokeAwsCredentials.mockReset();
  });

  it('never leaks the access key ID (whole or any 8+ char substring) on revoke', async () => {
    mockRevokeAwsCredentials.mockResolvedValue(true);

    const req: any = { params: { accessKeyId: FAKE_ACCESS_KEY_ID } };
    const res: any = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() };

    await revokeAwsCredentials(req, res);

    expect(res.json).toHaveBeenCalledWith({ message: 'Credentials revoked successfully' });

    const strings = loggedStrings();
    for (let start = 0; start + 8 <= FAKE_ACCESS_KEY_ID.length; start++) {
      const chunk = FAKE_ACCESS_KEY_ID.slice(start, start + 8);
      expect(strings.some((s) => s.includes(chunk))).toBe(false);
    }
    expect(strings.some((s) => /Revoked AWS credentials: [0-9a-f]{8}/.test(s))).toBe(true);
  });
});
