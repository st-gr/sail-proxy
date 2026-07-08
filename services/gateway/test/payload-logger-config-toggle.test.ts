/**
 * Payload logging must be togglable purely via api_config.json
 * (logging.payload_logging_enabled) with no DEBUG env var required.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

const mockGetConfig = jest.fn();
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getConfig: () => mockGetConfig() },
  getConfig: () => mockGetConfig(),
}));

jest.mock('../src/config/unifiedAuthConfig', () => ({
  isStandaloneMode: () => true,
}));

jest.mock('fs', () => ({
  ...(jest.requireActual('fs') as object),
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

import * as fs from 'fs';
import { savePayload, isPayloadLoggingEnabled } from '../src/utils/payloadLogger';

const configWithPayloadLogging = (enabled: boolean) => ({
  api_config: { logging: { log_folder_path: './logs', payload_logging_enabled: enabled } },
});

describe('payload logging config toggle (no DEBUG env required)', () => {
  const originalDebug = process.env.DEBUG;
  const originalPayloadEnv = process.env.PAYLOAD_LOGGING_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DEBUG;
    delete process.env.PAYLOAD_LOGGING_ENABLED;
  });

  afterEach(() => {
    if (originalDebug === undefined) delete process.env.DEBUG; else process.env.DEBUG = originalDebug;
    if (originalPayloadEnv === undefined) delete process.env.PAYLOAD_LOGGING_ENABLED; else process.env.PAYLOAD_LOGGING_ENABLED = originalPayloadEnv;
  });

  it('writes a payload file when config enables it and DEBUG is unset', () => {
    mockGetConfig.mockReturnValue(configWithPayloadLogging(true));
    savePayload('req-1', '00_test_stage', { hello: 'world' });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when config disables it', () => {
    mockGetConfig.mockReturnValue(configWithPayloadLogging(false));
    savePayload('req-2', '00_test_stage', { hello: 'world' });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('env PAYLOAD_LOGGING_ENABLED=false still hard-disables despite config true', () => {
    process.env.PAYLOAD_LOGGING_ENABLED = 'false';
    mockGetConfig.mockReturnValue(configWithPayloadLogging(true));
    savePayload('req-3', '00_test_stage', { hello: 'world' });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('isPayloadLoggingEnabled reflects the dynamic config per call (hot reload)', () => {
    mockGetConfig.mockReturnValue(configWithPayloadLogging(false));
    expect(isPayloadLoggingEnabled()).toBe(false);
    mockGetConfig.mockReturnValue(configWithPayloadLogging(true));
    expect(isPayloadLoggingEnabled()).toBe(true);
  });
});
