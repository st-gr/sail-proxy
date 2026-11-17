/**
 * The folder of the file payload logger (PAYLOAD_LOGGING_ENABLED): PAYLOAD_LOG_DIR when set, otherwise
 * the configured log folder + /payloads, resolved against the working directory. It never depends on
 * where the compiled file sits (the compiled dist/ tree put the files under dist/services/gateway/logs).
 *
 * @see ../src/utils/payloadLogger.ts
 */
import { describe, it, expect, jest } from '@jest/globals';
import * as path from 'path';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

import { resolvePayloadDir, getLogDir, isStreamDumpFile, payloadFilesNotice } from '../src/utils/payloadLogger';

const CWD = path.resolve('/srv/app');

describe('resolvePayloadDir', () => {
  it('takes an absolute PAYLOAD_LOG_DIR as it is', () => {
    expect(resolvePayloadDir({ PAYLOAD_LOG_DIR: '/data/payloads' }, './logs', CWD)).toBe(path.resolve('/data/payloads'));
  });

  it('resolves a relative PAYLOAD_LOG_DIR against the working directory', () => {
    expect(resolvePayloadDir({ PAYLOAD_LOG_DIR: 'debug/payloads' }, './logs', CWD)).toBe(path.join(CWD, 'debug', 'payloads'));
  });

  it('ignores a blank PAYLOAD_LOG_DIR', () => {
    expect(resolvePayloadDir({ PAYLOAD_LOG_DIR: '  ' }, './logs', CWD)).toBe(path.join(CWD, 'logs', 'payloads'));
  });

  it('without the variable: the configured log folder + payloads, relative to the working directory', () => {
    expect(resolvePayloadDir({}, './logs', CWD)).toBe(path.join(CWD, 'logs', 'payloads'));
  });

  it('an absolute configured log folder stays absolute (it was nested under the compiled folder)', () => {
    expect(resolvePayloadDir({}, '/var/log/sail', CWD)).toBe(path.resolve('/var/log/sail/payloads'));
  });
});

describe('getLogDir', () => {
  it('follows PAYLOAD_LOG_DIR and is independent of where the compiled module sits', () => {
    const saved = process.env.PAYLOAD_LOG_DIR;
    process.env.PAYLOAD_LOG_DIR = '/tmp/sail-payloads-test';
    try {
      expect(getLogDir()).toBe(path.resolve('/tmp/sail-payloads-test'));
    } finally {
      if (saved === undefined) delete process.env.PAYLOAD_LOG_DIR; else process.env.PAYLOAD_LOG_DIR = saved;
    }
  });

  it('defaults to logs/payloads under the working directory, never under dist', () => {
    const saved = process.env.PAYLOAD_LOG_DIR;
    delete process.env.PAYLOAD_LOG_DIR;
    try {
      expect(getLogDir()).toBe(path.join(process.cwd(), 'logs', 'payloads'));
    } finally {
      if (saved !== undefined) process.env.PAYLOAD_LOG_DIR = saved;
    }
  });
});

describe('payloadFilesNotice', () => {
  it('names the folder and says the files are not audited when file logging is on', () => {
    const line = payloadFilesNotice(true, '/app/services/gateway/logs/payloads');
    expect(line).toContain('/app/services/gateway/logs/payloads');
    expect(line).toMatch(/not audited/);
    expect(line).toMatch(/PAYLOAD_LOGGING_ENABLED/);
  });

  it('is null when file logging is off', () => {
    expect(payloadFilesNotice(false, '/x')).toBeNull();
  });
});

describe('isStreamDumpFile', () => {
  it('names the Anthropic stream dumps the sweeper also removes', () => {
    expect(isStreamDumpFile('2026-11-14T21-04-53-574Z_gateway-1-a_04_client_native_stream_response.txt')).toBe(true);
    expect(isStreamDumpFile('notes.txt')).toBe(false);
    expect(isStreamDumpFile('2026-11-14_gateway-1_02_sap_request_payload.json')).toBe(false);
  });
});
